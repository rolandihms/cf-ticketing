import { describe, expect, it } from "vitest";
import { buildIssue, githubIssues, sanitizeForGitHub } from "../src";
import { bug, fakeCtx, fakeFetch, json, ticket } from "./helpers";

type Env = { GITHUB_TOKEN?: string; GITHUB_REPO?: string };
const env: Env = { GITHUB_TOKEN: "t0k", GITHUB_REPO: "acme/app" };

function api(opts: { private?: boolean; existing?: unknown[]; labelStatus?: number; dropLabels?: boolean } = {}) {
  return fakeFetch((url, init) => {
    if (url.endsWith("/repos/acme/app")) return json({ private: opts.private ?? true, full_name: "acme/app" });
    if (url.endsWith("/repos/acme/app/labels") && init.method === "POST") return json({}, opts.labelStatus ?? 422);
    if (url.endsWith("/user")) return json({ login: "helpdesk-bot" });
    if (url.includes("/issues?")) return json(opts.existing ?? []);
    if (url.endsWith("/issues") && init.method === "POST") {
      const b = JSON.parse(String(init.body));
      const labels = opts.dropLabels ? [] : b.labels.map((name: string) => ({ name }));
      return json({ number: 42, html_url: "https://github.com/acme/app/issues/42", title: b.title, labels }, 201);
    }
    return json({ message: "not found" }, 404);
  });
}

const plugin = (f: ReturnType<typeof api>, extra = {}) =>
  githubIssues<Env>({ repo: ({ env }) => env.GITHUB_REPO, token: (e) => e.GITHUB_TOKEN, fetch: f.fetch, ...extra });

describe("githubIssues", () => {
  it("creates a sanitized issue for a code bug, links it and emits github.issue.created", async () => {
    const f = api();
    const { ctx, links, emitted } = fakeCtx(env);
    await plugin(f).onTicketClassified!(ctx);

    const post = f.calls.find((c) => c.init.method === "POST" && c.url.endsWith("/issues"))!;
    const sent = JSON.parse(String(post.init.body));
    expect(sent.title).toBe("[IHMS-000003] Export to CSV on the Reports page spins forever.");
    expect(sent.labels).toEqual(["from-helpdesk"]);
    expect(sent.body).toContain("<!-- cf-helpdesk:ticket:01TICKET0000000000000000AA -->");
    expect(sent.body).toContain("**Steps to reproduce:** Open Reports, click Export");
    expect(sent.body).not.toMatch(/https:\/\/evil|@alice|#12/);
    expect((post.init.headers as Record<string, string>).authorization).toBe("Bearer t0k");
    expect(links.get("github")).toMatchObject({ externalId: "acme/app#42", url: "https://github.com/acme/app/issues/42" });
    expect(emitted).toEqual([{ type: "github.issue.created", data: expect.objectContaining({ repo: "acme/app", number: 42, reused: false }) }]);
  });

  it("scans for duplicates by creator (label-independent) and ignores pull requests", async () => {
    const pr = { number: 5, pull_request: {}, html_url: "x", title: "x", body: `<!-- cf-helpdesk:ticket:${ticket.id} -->` };
    const f = api({ existing: [pr] });
    await plugin(f).onTicketClassified!(fakeCtx(env).ctx);
    const scan = f.calls.find((c) => c.url.includes("/issues?"))!;
    expect(scan.url).toContain("creator=helpdesk-bot");
    expect(scan.url).not.toContain("labels=");
    expect(f.calls.some((c) => c.init.method === "POST" && c.url.endsWith("/issues"))).toBe(true);
  });

  it("fails before creating anything when the token can't manage labels", async () => {
    const f = api({ labelStatus: 403 });
    await expect(plugin(f).onTicketClassified!(fakeCtx(env).ctx)).rejects.toThrow(/403/);
    expect(f.calls.some((c) => c.url.endsWith("/issues") && c.init.method === "POST" && c.url.endsWith("/issues"))).toBe(false);
  });

  it("warns when GitHub silently dropped the labels", async () => {
    const { ctx, events } = fakeCtx(env);
    await plugin(api({ dropLabels: true })).onTicketClassified!(ctx);
    expect(events.map((e) => e.type)).toEqual(["github.warning"]);
  });

  it("is off when no repo or token is configured", async () => {
    const f = api();
    await plugin(f).onTicketClassified!(fakeCtx<Env>({}).ctx);
    expect(f.calls).toHaveLength(0);
  });

  it("skips non-bug, non-code or low-confidence tickets", async () => {
    for (const c of [{ ...bug, category: "billing" }, { ...bug, codeRelated: false }, { ...bug, confidence: 0.5 }]) {
      const f = api();
      await plugin(f).onTicketClassified!(fakeCtx(env, { classification: c }).ctx);
      expect(f.calls).toHaveLength(0);
    }
  });

  it("supports a custom `when`", async () => {
    const f = api();
    await plugin(f, { when: (c: typeof bug) => c.category === "feature" }).onTicketClassified!(fakeCtx(env, { classification: { ...bug, category: "feature" } }).ctx);
    expect(f.calls.some((c) => c.init.method === "POST" && c.url.endsWith("/issues"))).toBe(true);
  });

  it("refuses public repos unless allowed, and records why", async () => {
    const f = api({ private: false });
    const { ctx, events } = fakeCtx(env);
    await plugin(f).onTicketClassified!(ctx);
    expect(f.calls.some((c) => c.init.method === "POST" && c.url.endsWith("/issues"))).toBe(false);
    expect(events).toEqual([{ type: "github.skipped", data: { repo: "acme/app", reason: "public repository" } }]);

    const g = api({ private: false });
    await plugin(g, { allowPublicRepos: true }).onTicketClassified!(fakeCtx(env).ctx);
    expect(g.calls.some((c) => c.init.method === "POST" && c.url.endsWith("/issues"))).toBe(true);
  });

  it("does nothing when the ticket is already linked", async () => {
    const f = api();
    const { ctx, links } = fakeCtx(env);
    links.set("github", { provider: "github", externalId: "acme/app#1", url: null, state: "open" });
    await plugin(f).onTicketClassified!(ctx);
    expect(f.calls).toHaveLength(0);
  });

  it("reuses an issue created by an earlier attempt (unknown outcome)", async () => {
    const existing = [{ number: 9, html_url: "https://github.com/acme/app/issues/9", title: "x", body: `... <!-- cf-helpdesk:ticket:${ticket.id} -->` }];
    const f = api({ existing });
    const { ctx, emitted } = fakeCtx(env);
    await plugin(f).onTicketClassified!(ctx);
    expect(f.calls.some((c) => c.init.method === "POST" && c.url.endsWith("/issues"))).toBe(false);
    expect(emitted[0]!.data).toMatchObject({ number: 9, reused: true });
  });

  it("surfaces GitHub errors (so the step retries) and validates the repo name", async () => {
    const f = fakeFetch(() => json({ message: "Bad credentials" }, 401));
    await expect(plugin(f).onTicketClassified!(fakeCtx(env).ctx)).rejects.toThrow(/401/);
    await expect(plugin(api()).onTicketClassified!(fakeCtx({ ...env, GITHUB_REPO: "not a repo" }).ctx)).rejects.toThrow(/Invalid GitHub repo/);
  });
});

describe("sanitizeForGitHub / buildIssue", () => {
  it("neutralises mentions, references, links and HTML", () => {
    const s = sanitizeForGitHub("<img src=x onerror=alert(1)>Ping @octocat about #123 and GH-4 at https://x.y/z or www.x.y");
    expect(s).toBe("Ping @​octocat about #​123 and GH​-4 at [link removed] or [link removed]");
  });
  it("falls back when the classification has no summary", () => {
    expect(buildIssue({ ticket, classification: { ...bug, summary: undefined, details: undefined } }).title).toBe("[IHMS-000003] Bug reported via help desk");
  });
});
