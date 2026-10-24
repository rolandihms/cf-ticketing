# CF Helpdesk: architecture and implementation plan (v2, revised after Fable review)

Goal: an open-source, reusable help desk boilerplate that runs on Cloudflare. Anyone can configure it for their own Cloudflare account. An inbound email creates a ticket with a reference, the customer gets an acknowledgement that carries the reference, and extensible workflows then run on the ticket. Later phases add AI classification, AI replies and GitHub issues.

Status: research done (October 2026, wrangler 4.151.0). Verdict: **feasible today on Cloudflare-native primitives.**

---

## 1. Verified platform facts this design relies on

| Need | Cloudflare primitive | Notes |
|---|---|---|
| Receive email | Email Routing → Email Worker `email(message, env, ctx)` | 25 MiB max inbound. `message.raw` is a one-shot stream. Parse with `postal-mime`. |
| Route address → Worker | `"addresses": ["support@x.com"]` in `wrangler.jsonc` (top-level) | `wrangler deploy` creates the routing rule (verified in the config schema). There is also `wrangler email routing rules create`. |
| Enable routing on a zone | `wrangler email routing enable <domain>` | The domain must use Cloudflare DNS. |
| Reply to sender | `message.reply(EmailMessage)` | Allowed only inside the email handler, once per message, back to the original sender, and only when the inbound mail passes DMARC. |
| Send to anyone | Email Service "Email Sending": `send_email` binding → `env.EMAIL.send({to, from, subject, text, html, headers})` | **Public beta.** Sending to arbitrary recipients needs **Workers Paid** (3,000 per month included, then $0.35 per 1,000). Onboard the domain with `wrangler email sending enable <domain>`. |
| Durable multi-step processing | Workflows: `env.WF.create({ id, params })` | Instance id max 100 chars, `[a-zA-Z0-9_-]`, unique, so it can serve as a dedupe key. Params and step results max 1 MiB each. `step.do` retries 5× by default. `step.waitForEvent` and `step.sleep` are available. |
| Blob storage | R2 | Holds raw `.eml` files and attachments. |
| DB: Cloudflare-native | D1 (SQLite; local SQLite under Miniflare in `wrangler dev`) | No interactive transactions. `batch()` is atomic. `RETURNING` works. |
| DB: Postgres / MySQL | Hyperdrive (`pg`, `mysql2`). Local dev uses `localConnectionString`. | MySQL needs TLS. A LAN DB needs a Cloudflare Tunnel or Workers VPC. |
| DB: PlanetScale | Vitess via `@planetscale/database` (HTTP). PlanetScale Postgres via Hyperdrive. | |
| Local test of inbound mail | `wrangler dev` + `POST /cdn-cgi/local/email?from=&to=` with raw RFC 5322 | Without `remote: true`, `send_email` logs to disk locally. |

Setup can be fully scripted with `wrangler`: create D1 and R2, enable routing, enable sending, run migrations, deploy (which creates the routing rule). The one hard prerequisite is a domain on Cloudflare DNS.

---

## 2. Architecture

```
 customer ──SMTP──▶ Cloudflare Email Routing (support@acme.com)
                           │  rule (created by wrangler deploy via "addresses")
                           ▼
                 ┌─────────────────────────┐
                 │ Worker: email() handler │  fast + minimal
                 │ 1. buffer raw (≤25 MiB) │
                 │ 2. loop/abuse guards    │
                 │ 3. R2 put raw/<key>.eml │
                 │ 4. WF.create({id:key})  │  key = sha256(mailbox + norm(Message-ID
                 │                         │        ?? from+date+subj+bodyhash))
                 └───────────┬─────────────┘
                             ▼
       ┌──────────────── Workflow: InboundEmailWorkflow ────────────────┐
       │ step "parse"        postal-mime from R2 → bodies to R2; returns  │
       │                     metadata + R2 keys only (1 MiB step limit) │
       │ step "attachments"  → R2                                       │
       │ step "resolve"      In-Reply-To/References → our stored        │
       │                     Message-IDs first; subject [REF] token only │
       │                     if sender is requester/CC/agent            │
       │ step "persist"      new ticket (+ref) or append message;        │
       │                     on unique-violation → look up & continue   │
       │ step "ack"          env.EMAIL.send(ack w/ ref, threaded headers)│
       │ step "hooks:*"      run registered plugins, one step each       │
       └────────────────────────────────────────────────────────────────┘
                             │
          Worker fetch(): Hono REST API (tickets, assign, status, reply)
          secured by Cloudflare Access JWT or API key.  UI later.
```

### Why use a Workflow and not do the work in the email handler
- Retries, durability and observability come for free. A DB outage doesn't lose mail, because the raw message is already in R2 and the step retries.
- It is the natural extension point for "dynamic workflows" (see §4).
- The trade-off is that `message.reply()` can't be used from a Workflow, so the acknowledgement goes through Email Sending (Workers Paid). We also need Email Sending anyway for agent and AI replies later.
- **Fallback for Free plan / no Email Sending**: `ACK_MODE=reply`. In this mode the handler creates the ticket synchronously and calls `message.reply()`, then starts the Workflow with `skipAck`. That keeps the free-plan story intact, with the documented caveat that non-DMARC senders get no ack.

### Loop and abuse guards (in the handler, before any work)
- Drop or skip the ack when any of these hold:
  - `Auto-Submitted` is present and not `no`
  - `Precedence: bulk|list|junk`
  - `List-Id` / `List-Unsubscribe` is present (configurable)
  - the sender is `mailer-daemon@*` / `postmaster@*` / `noreply*`
  - the sender is one of our own mailboxes
- Every outbound email carries `Auto-Submitted: auto-replied` and `X-Helpdesk-Ticket: <ref>`.
- Per-sender ack rate limit (e.g. 5/hour) using the Workers Rate Limiting binding, so we can't be used as a backscatter cannon.
- `setReject()` for mail over the size limit or to unknown mailboxes.

---

## 3. Data layer: Kysely + pluggable dialects

**Decision: Kysely** (one typed `Database` interface and one query codebase across all backends). Drizzle still needs a separate schema per dialect, and its v1 is still in RC.

| `DB_DRIVER` | Binding / connection | Kysely dialect |
|---|---|---|
| `d1` (default) | D1 binding | `kysely-d1` (vendored, ~100 LOC) |
| `postgres` | Hyperdrive + `pg` | built-in `PostgresDialect` |
| `mysql` | Hyperdrive + `mysql2` (`disableEval`) | built-in `MysqlDialect` |
| `planetscale` | `@planetscale/database` HTTP | `kysely-planetscale` (vendored) |
| `planetscale-pg` | Hyperdrive + `pg` | `PostgresDialect` |
| `sqlite` (local) | D1 local under Miniflare | same as `d1` |

Portability rules:
- IDs are ULIDs generated in the app (`TEXT` / `CHAR(26)`).
- Timestamps are epoch-ms `BIGINT` set by the app.
- JSON is stored as text and never queried inside SQL.
- Booleans are 0/1.
- No DB defaults or triggers.
- No reliance on FK enforcement (Vitess), though FKs are declared where supported.

The DB-specific bits live behind a small `Repo` interface. The main one is ticket numbering:
- **SQLite/D1 & Postgres**: `UPDATE counters SET value = value + 1 WHERE scope = ? RETURNING value`. It is a single atomic statement. On D1 it is batched with the ticket insert.
- **MySQL/Vitess**: inside a transaction, run `UPDATE counters SET value = LAST_INSERT_ID(value + 1) WHERE scope = ?; SELECT LAST_INSERT_ID();`.
- `UNIQUE(mailbox_id, number)` is the backstop.
- The ref is formatted in the app: `{PREFIX}-{zero-padded number}`, with the prefix per mailbox (e.g. `ACME-000123`).

Migrations:
- They are written once as Kysely schema-builder TS, with per-dialect switches where types differ.
- A generator script compiles them to SQL in `migrations/{sqlite,postgres,mysql}/NNNN_name.sql`. The generated SQL is checked in and reviewable.
- D1 applies them with `wrangler d1 migrations apply`. Postgres/MySQL apply them with `pnpm db:migrate`, a Node script using the same SQL.

### Core schema (v1)
- `mailboxes`: id, address (unique), name, ref_prefix, from_name, ack_template, settings_json
- `contacts`: id, email (unique), name, created_at
- `agents`: id, email (unique), name, role (`admin|agent`), active
- `tickets`: id, mailbox_id, number, ref (unique), subject, status (`new|open|pending|on_hold|solved|closed`), priority, requester_id, assignee_id, tags_json, source (`email|api|web`), created_at, updated_at, closed_at
- `messages`: id, ticket_id, direction (`inbound|outbound|note`), message_id_hdr (unique per mailbox_id), in_reply_to, from_addr, to_addrs, cc_addrs, subject, text_body, html_r2_key, raw_r2_key, author_agent_id, created_at
- `attachments`: id, message_id, r2_key, filename, mime, size
- `ticket_events`: id, ticket_id, type, actor, data_json, created_at (audit log, also the feed the hooks use)
- `counters`: scope (PK), value
- `webhooks`: id, url, secret, events_json, active

---

## 4. Extensibility ("workflows we can extend dynamically")

Workflow classes themselves are static code, so extension works on three levels:

1. **In-code plugins (primary).** `defineHelpdesk({ plugins: [...] })` in a single `helpdesk.config.ts`:
   ```ts
   export interface HelpdeskPlugin {
     name: string;
     onTicketCreated?(ctx: HookContext): Promise<void | HookResult>;
     onMessageReceived?(ctx: HookContext): Promise<void | HookResult>;
     onTicketUpdated?(ctx: HookContext): Promise<void | HookResult>;
   }
   ```
   - Each hook runs inside its own `step.do("plugin:<name>:<event>")`, so every plugin gets retries and isolation.
   - `HookContext` exposes the ticket and message, plus `db` repo, `email`, `env`, `step` (for sleep/waitForEvent), and a logger.
   - Future AI-classify, AI-reply and GitHub-issue features are just plugins.
2. **Outbound webhooks (no-code).** Rows in `webhooks`, called from a step with an HMAC signature, cover n8n/Zapier/your-other-projects integration.
3. **Dedicated Workflows per plugin** for long-running work such as "wait for GitHub issue close → reply to customer". A plugin can start its own Workflow binding and use `waitForEvent`.

Other projects embed it in two ways:
- deploy one instance per project with its own mailbox and DB, or
- deploy one shared instance with many `mailboxes` rows. Each project gets an address and a ref prefix, and webhooks fan out per mailbox.

---

## 5. Repo layout (pnpm monorepo, publishable)

```
cf-helpdesk/
  packages/core/        domain types, ticket service, threading, guards, plugin API
  packages/db/          Kysely schema, dialect factory, repos, migrations + generator
  packages/email/       MIME parse, ack/agent templates, send adapters (Email Sending | reply)
  apps/worker/          the deployable Worker: email(), fetch() (Hono API), Workflows
    wrangler.jsonc.example
    helpdesk.config.ts  ← user's plugins & settings
  packages/cli (`npm run setup`)      interactive: domain, address, DB driver → creates D1/R2,
                        enables routing+sending, writes wrangler.jsonc, migrates, deploys
  examples/plugins/     echo/logging plugin, webhook plugin (AI/GitHub later)
  docs/
```

Tooling: TypeScript, Vitest + `@cloudflare/vitest-plugin` (renamed from vitest-pool-workers), GitHub Actions CI, MIT license.

---

## 6. Phased delivery

**Phase 1: "email in → ticket → ack → workflow" (the requested first step)**
1. Scaffold the monorepo, set up wrangler config, CI and lint.
2. Build the D1 adapter, schema and migrations, with the counter-based ref.
3. Write the email handler with guards, R2 storage and Workflow creation (idempotent id).
4. Build InboundEmailWorkflow: parse → resolve thread → persist → ack → plugin hooks.
5. Add the Email Sending ack (threaded headers), plus the `ACK_MODE=reply` fallback.
6. Add an example plugin and a webhook.
7. Write tests: unit (parse, guards, threading), integration (vitest-pool-workers), and a local e2e via `/cdn-cgi/local/email`.
8. Write `packages/cli (`npm run setup`)`, then deploy to your domain and send a real email end to end.

**Phase 2: help desk basics.** REST API (list/filter/assign/status/notes/agent reply via Email Sending), Cloudflare Access auth, and the Postgres/MySQL/PlanetScale adapters with a CI matrix (Docker PG/MySQL).

**Phase 3: Integrations.** AI classification and priority (Workers AI or Claude), suggested and auto replies, GitHub issue sync, and SLA timers with `step.sleep`.

**Phase 4: UI.** An agent dashboard (React on Workers static assets) and a customer portal ("view my tickets" via magic link).

---

## 7. Risks and open questions
- **Email Sending is in public beta.** Mitigation: send adapters are swappable (Email Sending, `reply()`, or a third-party provider such as Resend/Postmark/SES behind the same interface).
- **Workers Paid ($5/mo)** is needed for acks to arbitrary customers. The Free plan works only in `ACK_MODE=reply`, subject to the DMARC caveat.
- **Spoofed `From`.** Inbound auth results should be recorded, and unauthenticated senders should get no ack or be flagged.
- **MySQL needs TLS and has no RETURNING.** Handled in the repo layer.
- **Kysely community dialects (D1, PlanetScale) are quiet.** Mitigation: vendor them.
- **Hyperdrive to a local or LAN DB** needs a Tunnel or Workers VPC in production. Local dev is fine.

---

## 8. Fable review: outcome and changes adopted

Verdict from the review: **feasible on Cloudflare-native primitives, and Phase 1 is a realistic ~2-week build.** The review confirmed the platform facts in §1, with the corrections and additions below.

**Day-1 spikes: all resolved on 2026-10-14. See docs/SPIKES.md (raw MIME keeps every header except Message-ID, which Cloudflare rewrites).**
1. **Email Sending header allowlist (blocker until checked).** `send()` headers are "subject to an allowlist", and the list is undocumented. It may strip `In-Reply-To`, `References`, `Auto-Submitted` or `X-Helpdesk-Ticket`. Spike: send a message through the binding and inspect what arrives. If headers are stripped, fall back to sending a raw RFC 5322 message (built with `mimetext`) through `send(EmailMessage)`. Store the returned `messageId` so customer replies thread back.
2. **Workflows under `@cloudflare/vitest-plugin` (renamed from vitest-pool-workers).** If they aren't supported, unit-test the `run()` body with a fake `step`.
3. **Sending from inside a Workflow step.** This is undocumented but expected to work, so confirm it in the e2e test. Local dev needs `remote: true` on the binding to actually send.

**Design changes**
- **Idempotency key** = `sha256(mailbox + normalized Message-ID ?? from+date+subject+bodyhash)`. The original key would have let an attacker reuse a Message-ID to suppress someone else's mail. Mail CC'd to two mailboxes would also have collapsed into one ticket. A duplicate `create()` is caught and treated as success. The DB unique constraint is the real backstop, because Workflow ids are only reserved during the retention period.
- **Threading:** stored outbound Message-IDs are matched first. A subject ref is trusted only from the requester, a CC or an agent. Otherwise a new ticket is opened with a `possible_related` event, since refs are sequential and guessable.
- **The 1 MiB step limit:** bodies and attachments go to R2, and steps return only keys and metadata.
- **Plugins:** each hook runs in `step.do("plugin:<name>:<event>", { retries: { limit: 2 } })`. A failure is caught and recorded in `ticket_events`, so it never wedges the instance. Plugins get a namespaced `step` wrapper. Changes to the plugin set affect in-flight instances, and this is documented.
- **Email Sending errors:** `E_RECIPIENT_SUPPRESSED` and `E_SENDER_NOT_VERIFIED` are `NonRetryableError`. `E_DAILY_LIMIT_EXCEEDED` is retried with long backoff, because new accounts get a ramping daily quota.
- **Extra loop guards:**
  - `X-Auto-Response-Suppress`
  - `multipart/report` (DSNs)
  - an empty envelope sender
  - acks only on ticket creation by default
  - the ack decision is computed inside a step
- **Spoofing:** `Authentication-Results` is parsed if present. Otherwise we rely on Cloudflare's edge rejection of SPF/DKIM/DMARC failures and record `auth: "edge-accepted"`. The README promises nothing more.
- **Handler errors:** mail is stored in R2 and the Workflow is created with `await` (never `waitUntil`). A throw is expected to make the sender's MTA retry. This behaviour is undocumented, so the design must tolerate redelivery, and it does.
- **MySQL counter:** `UPDATE ... SET value=value+1` followed by `SELECT value` in the same transaction. This is simpler than `LAST_INSERT_ID`.
- **`ACK_MODE=reply` (free plan):** kept, but it reuses the same `ingest()` function as the persist step, and the Workflow tolerates "already persisted".
- **Phase 1 additions:**
  - the setup script seeds the `mailboxes` and `counters` rows
  - `setReject` handles unknown recipients on catch-all
  - `observability.enabled` is on
  - `addresses` is top-level only in `wrangler.jsonc`, and `workflows` bindings aren't inherited by named envs

**Cut from Phase 1 (moved to Phase 2)**
- The multi-dialect migration generator. Phase 1 uses a hand-written `migrations/sqlite/0001_init.sql`.
- The `webhooks` table and the HMAC webhook plugin.
- The `planetscale-pg` driver. It is just `postgres` with a flag.
- The package split. Phase 1 has only `apps/worker` and `packages/core`, and splits happen when a second consumer exists.
- `ticket_events` as a hook feed. It stays an audit log only.

### Revised Phase 1 checklist
1. Scaffold `apps/worker` and `packages/core`: TS, Vitest, CI, MIT license, `wrangler.jsonc.example`.
2. Run spikes 1–3 above.
3. Write the D1 schema (`0001_init.sql`) and a Kysely repo, using a vendored `kysely-d1` and the counter batch-with-subquery pattern.
4. Write the email handler: guards, the idempotency key, R2 put, and `WF.create` with duplicate handling.
5. Build InboundEmailWorkflow: parse → resolve → persist → ack → plugin hooks.
6. Add an example logging plugin.
7. Write tests: unit, integration, and a local e2e via `/cdn-cgi/local/email`.
8. Write `packages/cli (`npm run setup`)`. It enables routing and sending, creates D1 and R2, writes the config, migrates, seeds, and deploys. Then do a real end-to-end email test on your domain.
