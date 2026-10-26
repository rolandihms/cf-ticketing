# Integrations: GitHub issues and webhooks

Both integrations are **optional plugins** (`packages/plugins`), enabled in `apps/worker/helpdesk.config.ts`. They stay off until you set their variables.

```
email → ticket → classify ──► github-issues ──(emits)──► github.issue.created ──► webhooks ──► your system
                     │                                                                ▲
                     └────────────── ticket.classified ───────────────────────────────┘
```

## 1. GitHub issues for bug tickets

Once a ticket is classified, the `github-issues` plugin opens an issue when the default rule `when` matches: category `bug`, code-related, and confidence ≥ 0.7.

**What gets posted:**
- The **title** is `[IHMS-000003] <first sentence of the AI summary>`.
- The **body** contains the redacted AI summary plus the extracted details (component, steps to reproduce, expected, actual), the ticket ref and a hidden marker.
- The customer's email, name and address are **never** posted.
- Mentions (`@user`), issue references (`#12`), links and HTML are neutralised.
- The issue gets the label `from-helpdesk`.

**Safety and idempotency:**
- Only **private repositories** are used by default. Visibility is checked at runtime with the GitHub API. Public repos are skipped and recorded as a `github.skipped` ticket event; use `allowPublicRepos: true` to override.
- One issue per ticket. The link is stored in `ticket_links`. If a retry happens after an unknown outcome, the token user's 100 most recent issues are scanned for the hidden ticket marker and the issue is reused.
- The plugin first makes sure the `from-helpdesk` label exists. A token that can't manage labels therefore fails before any issue is created. If GitHub silently drops the labels anyway, a `github.warning` event is recorded.
- Every GitHub call runs inside a Workflow step. Network errors and `5xx` are retried with backoff; other `4xx` errors fail immediately, since retrying won't fix them. A completed step is never repeated.
- Anyone who can open issues in the repo could forge a ticket marker. Keep the repo private, which is the default.

### Setup

1. **Create a fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Repository access: **Only select repositories**, then pick your repo.
   - Permissions: **Issues: Read and write**. Metadata: Read is added automatically.
2. **The label** `from-helpdesk` is created automatically. This needs push access, which a token with **Issues: write** on your own repo has.
3. **Configure the Worker:**
   ```bash
   cd apps/worker
   npx wrangler secret put GITHUB_TOKEN          # paste the token
   ```
   Then set the repo in `wrangler.jsonc` and deploy:
   ```jsonc
   "vars": { "GITHUB_REPO": "your-org/your-app" }
   ```

**Per-project routing.** If one help desk serves several projects, return a repo per mailbox:

```ts
githubIssues<Env>({
  repo: ({ mailbox }) => ({ "support@app-a.com": "org/app-a", "support@app-b.com": "org/app-b" })[mailbox.address] ?? null,
  token: (env) => env.GITHUB_TOKEN,
  when: (c) => c.codeRelated && ["bug", "feature"].includes(c.category) && c.confidence >= 0.8,
  labels: ["from-helpdesk", "triage"],
})
```

**Roadmap:**
- Phase B: an approval mode, where an agent approves before posting (required for public repos), and GitHub App auth.
- Phase C: a GitHub webhook back to the help desk when the issue is closed.

### Live test (2026-10-19, ihms.dev → private `rolandihms/cf-helpdesk-test-issues`)

| Email | Classification | Result |
|---|---|---|
| "Dashboard charts stay empty after the latest release" | `bug` 0.9, code-related (LLM) | Issue #1 opened with the `from-helpdesk` label. `ticket_links` row and `github.issue.created` event recorded. |
| "Invoice PDF download returns a blank file" (before the rules fix) | `billing` 0.8 (keyword rule) | No issue. The "invoice" keyword short-circuited the LLM. |
| Same email, after the rules fix | rules hint `billing` 0.6 (not accepted) → LLM `bug` 0.9 | Issue #2 opened. |

The issue body contained only the AI summary and the extracted details (component, steps, expected, actual). There were no customer names, addresses or links. The fine-grained PAT with **Issues: read & write** on that single repo was enough for every call: label creation, `/user`, the repo visibility check, issue listing and issue creation.

## 2. Triggering another system: webhooks

The `webhooks` plugin POSTs a **signed JSON payload** to any URL whenever a matching event happens.

| Event | When |
|---|---|
| `ticket.created` | A new ticket was opened from an email |
| `message.received` | A customer replied on an existing ticket |
| `ticket.classified` | Classification finished (category, confidence, codeRelated) |
| `github.issue.created` | The GitHub plugin opened (or re-linked) an issue |
| *your own* | Any plugin can `ctx.emit("namespace.name", data)` |

### Setup

```bash
npx wrangler secret put WEBHOOK_SECRET    # random string shared with the receiver
```
```jsonc
"vars": { "WEBHOOK_URL": "https://ops.example.com/hooks/helpdesk" }
```

To send to several systems, add more endpoints in `helpdesk.config.ts`, each with its own `events` filter, secret and headers.

### Request

```
POST /hooks/helpdesk
content-type: application/json
x-helpdesk-event: github.issue.created
x-helpdesk-delivery: IHMS-000003:3f9a2c1b7d4e:4:github.issue.created    ← dedupe on this
x-helpdesk-timestamp: 1792141964                                         ← unix seconds
x-helpdesk-signature-256: sha256=<hex HMAC-SHA256(WEBHOOK_SECRET, "<timestamp>.<raw body>")>

{
  "id": "IHMS-000003:3f9a2c1b7d4e:4:github.issue.created",
  "type": "github.issue.created",
  "occurredAt": "2026-10-16T09:12:44.000Z",
  "source": "github-issues",
  "ticket": { "id": "01M…", "ref": "IHMS-000003", "status": "new", "priority": "high",
              "category": "bug", "summary": "Export to CSV on the Reports page spins forever." },
  "data": { "repo": "acme/app", "number": 42, "url": "https://github.com/acme/app/issues/42",
            "title": "[IHMS-000003] Export to CSV …", "reused": false }
}
```

The payload contains no customer contact details.

**Delivery semantics:**
- At-least-once delivery.
- Network errors, `5xx`, `408` and `429` are retried with exponential backoff.
- Any other `4xx` is not retried, and **redirects are never followed**. Both are recorded on the ticket as `webhook.rejected`.
- When retries run out, the failure is recorded as `webhook.failed`. Each endpoint is isolated, so one receiver being down never blocks the others.
- Receivers **must** dedupe on `x-helpdesk-delivery`, and should reject stale timestamps. `verifyWebhookSignature` rejects anything more than 5 minutes old.

### Verifying in the receiver

```ts
import { verifyWebhookSignature } from "@rolandihms/helpdesk-plugins"; // or copy the 10 lines below

export default {
  async fetch(req: Request, env: { WEBHOOK_SECRET: string }) {
    const raw = await req.text();
    const ok = await verifyWebhookSignature(
      env.WEBHOOK_SECRET, raw, req.headers.get("x-helpdesk-signature-256"), req.headers.get("x-helpdesk-timestamp"),
    );
    if (!ok) {
      return new Response("bad signature", { status: 401 });
    }
    const event = JSON.parse(raw);
    // … dedupe on event.id, then act (create a Linear/Jira ticket, post to Slack, start a CI job …)
    return new Response("ok");
  },
};
```

Without the package:
1. Check that `x-helpdesk-timestamp` is within 5 minutes of now.
2. Compute `HMAC-SHA256(secret, timestamp + "." + rawBody)` as hex.
3. Compare it in constant time with the value after `sha256=`, and reject on mismatch.

### Alternatives

| Need | Option |
|---|---|
| React to the **GitHub issue itself** (labels, comments, close) | Use GitHub's own repository webhooks (`issues` events) directly. No help desk code needed. |
| Another **Cloudflare Worker** in your account | A webhook to its URL works today. A Queue or service-binding transport plugin is a small addition if you want delivery without the public internet. |
| Slack/Teams | Point a webhook at a small adapter Worker, or write a 20-line plugin with `onEvent`. |

## 3. Writing your own integration

Any plugin can react to and publish events:

```ts
import type { HelpdeskPlugin } from "@rolandihms/helpdesk-core";

export const linear: HelpdeskPlugin<Env> = {
  name: "linear",
  async onTicketClassified(ctx) {
    if (ctx.classification.category !== "feature") return;
    const issue = await ctx.step.do("create", () => createLinearIssue(ctx.env, ctx.classification.summary));
    await ctx.step.do("link", () => ctx.services.saveLink({ provider: "linear", externalId: issue.id, url: issue.url, state: "open" }));
    await ctx.emit("linear.issue.created", { id: issue.id, url: issue.url });   // → webhooks, other plugins
  },
};
```

**Rules:**
- Put side effects inside `ctx.step.do(...)`. Those calls are durable, retried and run once.
- Use `ctx.services` for ticket storage.
- Event types are `namespace.name`, max 64 characters.
- Decide *whether* to emit inside a step, as `github-issues` does with its `route` step, so a replayed run emits the same events.
- A plugin never receives its own events.
