import type { ClassificationOutcome, HelpdeskPlugin, HookContext } from "@cf-helpdesk/core";

export interface GitHubIssuesOptions<Env> {
  name?: string;
  /** "owner/repo" for this ticket (e.g. per mailbox). Return null/undefined to skip. */
  repo: (ctx: HookContext<Env>) => string | null | undefined;
  /** Fine-grained PAT (Issues: read & write on that repo only) or a GitHub App installation token. */
  token: (env: Env) => string | undefined;
  /** When to open an issue. Default: category "bug", code-related, confidence ≥ 0.7. */
  when?: (c: ClassificationOutcome) => boolean;
  /** Labels to apply. The first label is also used to find issues we created (idempotency). */
  labels?: string[];
  /** Allow posting to public repositories. Default false: public repos are skipped and recorded. */
  allowPublicRepos?: boolean;
  /** GitHub Enterprise: https://ghe.example.com/api/v3 */
  apiBase?: string;
  fetch?: typeof fetch;
}

export interface CreatedIssue {
  repo: string;
  number: number;
  url: string;
  title: string;
  reused: boolean;
}

export const defaultWhen = (c: ClassificationOutcome) => c.category === "bug" && c.codeRelated && c.confidence >= 0.7;

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const marker = (ticketId: string) => `<!-- cf-helpdesk:ticket:${ticketId} -->`;

/**
 * Make untrusted text safe to post on GitHub: no @mentions, no #/GH- cross-references, no links,
 * no HTML. Content comes from the LLM summary (already redacted), never from the raw email.
 */
export function sanitizeForGitHub(text: string, max = 4000): string {
  return text
    .replace(/`{3,}|~{3,}/g, "") // no code fences: an unclosed one would swallow the rest of the body
    .replace(/<\/?[A-Za-z!][^>]*>/g, "") // HTML tags only; leaves "x < y > z" prose intact
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\bwww\.\S+/gi, "[link removed]")
    .replace(/@(?=[A-Za-z0-9-])/g, "@​")
    .replace(/#(?=\d)/g, "#​")
    .replace(/\bGH-(?=\d)/gi, "GH​-")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
}

export function buildIssue(ctx: { ticket: HookContext["ticket"]; classification: ClassificationOutcome }) {
  const { ticket, classification: c } = ctx;
  const headline = sanitizeForGitHub((c.summary ?? "Bug reported via help desk").split(/(?<=[.!?])\s/)[0]!, 100);
  const title = `[${ticket.ref}] ${headline}`;
  const d = c.details ?? {};
  const section = (label: string, v?: string) => (v ? `**${label}:** ${sanitizeForGitHub(v, 1500)}\n\n` : "");
  const body =
    `> Opened automatically from help desk ticket **${ticket.ref}** ` +
    `(category \`${c.category}\`, confidence ${c.confidence.toFixed(2)}${c.acceptedBy ? `, via ${c.acceptedBy}` : ""}).\n` +
    `> The customer's original email is kept in the help desk and is not posted here.\n\n` +
    `## Summary\n\n${sanitizeForGitHub(c.summary ?? "(no summary)")}\n\n` +
    (Object.keys(d).length
      ? `## Details\n\n` +
        section("Component", d.component) +
        section("Steps to reproduce", d.stepsToReproduce) +
        section("Expected", d.expected) +
        section("Actual", d.actual)
      : "") +
    marker(ticket.id);
  return { title, body };
}

/** `status` lets the runner treat 4xx (except 408/429) as non-retryable. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Open a GitHub issue for code-related bug tickets (docs/AI-PIPELINE.md §6, Phase A3: `auto` mode,
 * private repos). Emits `github.issue.created`, which other plugins (e.g. webhooks) can act on.
 *
 * Idempotent: the ticket↔issue link is stored in ticket_links; before creating, our most recent
 * issues are scanned for the ticket marker, so a retry after an unknown outcome reuses the issue.
 * Note: anyone who can open issues in the repo could forge a marker; keep repos private (default).
 */
export function githubIssues<Env>(opts: GitHubIssuesOptions<Env>): HelpdeskPlugin<Env> {
  const when = opts.when ?? defaultWhen;
  const labels = opts.labels ?? ["from-helpdesk"];
  if (labels.length === 0) throw new Error("githubIssues: at least one label is required");
  const apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const gh = async (token: string, path: string, init: RequestInit = {}) => {
    const res = await doFetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "cf-helpdesk",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new GitHubError(`GitHub ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`, res.status);
    }
    return res.json() as Promise<any>;
  };

  return {
    name: opts.name ?? "github-issues",
    async onTicketClassified(ctx) {
      const repo = opts.repo(ctx);
      const token = opts.token(ctx.env);
      if (!repo || !token) return; // integration not configured: silently off
      if (!REPO_RE.test(repo)) throw new Error(`Invalid GitHub repo "${repo}" (expected owner/name)`);

      // Evaluate routing inside a step so a replay after a config change keeps the original decision.
      const route = await ctx.step.do("route", async () => ({ create: when(ctx.classification) }));
      if (!route.create) return;

      const existing = await ctx.step.do("link:check", () => ctx.services.getLink("github"));
      if (existing) return;

      const visibility = await ctx.step.do("repo:check", async () => {
        const r = await gh(token, `/repos/${repo}`);
        return { private: !!r.private, fullName: String(r.full_name) };
      });
      if (!visibility.private && !opts.allowPublicRepos) {
        await ctx.step.do("skip:public", () => ctx.services.addEvent("github.skipped", { repo, reason: "public repository" }));
        ctx.log("skipped: public repository", { repo });
        return;
      }

      // Make sure our label exists. A token that cannot manage labels fails here, loudly, before any
      // issue is created (GitHub silently drops labels on create for tokens without push access).
      await ctx.step.do("label:ensure", async () => {
        try {
          await gh(token, `/repos/${repo}/labels`, { method: "POST", body: JSON.stringify({ name: labels[0], color: "5319e7", description: "Opened by the help desk" }) });
        } catch (err) {
          if (!(err instanceof GitHubError && err.status === 422)) throw err; // 422 = already exists
        }
        return true;
      });

      // Who are we? Lets the duplicate scan filter by creator (null for tokens that can't call /user).
      const me = await ctx.step.do("whoami", async () => {
        try {
          return { login: String((await gh(token, "/user")).login) as string | null };
        } catch {
          return { login: null as string | null };
        }
      });

      const issue = await ctx.step.do("issue:create", async (): Promise<CreatedIssue & { labelled: boolean }> => {
        // Unknown outcome of a previous attempt (POST succeeded, step didn't)? Reuse that issue.
        // Label-independent scan of our most recent issues for the ticket marker.
        const q = `state=all&sort=created&direction=desc&per_page=100${me.login ? `&creator=${encodeURIComponent(me.login)}` : ""}`;
        const recent: any[] = await gh(token, `/repos/${repo}/issues?${q}`);
        const found = recent.find((i) => !i.pull_request && typeof i.body === "string" && i.body.includes(marker(ctx.ticket.id)));
        if (found) return { repo, number: found.number, url: found.html_url, title: found.title, reused: true, labelled: true };
        const { title, body } = buildIssue(ctx);
        const created = await gh(token, `/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body, labels }) });
        const labelled = Array.isArray(created.labels) && created.labels.some((l: { name?: string }) => l?.name === labels[0]);
        return { repo, number: created.number, url: created.html_url, title: created.title, reused: false, labelled };
      });
      if (!issue.labelled) {
        await ctx.step.do("warn:labels", () =>
          ctx.services.addEvent("github.warning", { repo, number: issue.number, warning: "labels were not applied; the token likely lacks push access" }),
        );
      }

      await ctx.step.do("link:save", () =>
        ctx.services.saveLink({ provider: "github", externalId: `${repo}#${issue.number}`, url: issue.url, state: "open", data: { repo, number: issue.number } }),
      );
      await ctx.emit("github.issue.created", { repo, number: issue.number, url: issue.url, title: issue.title, reused: issue.reused });
      ctx.log("github issue created", { repo, number: issue.number });
    },
  };
}
