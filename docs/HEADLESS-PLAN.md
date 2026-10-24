# Headless help desk: embedding plan

CF Helpdesk ships as **packages plus a CLI** that drop into an existing product. The host keeps its own UI, auth and database. The first host is **Realty On Record** (`portal-tech/portal_he_ui`). A standalone UI applet comes later. Fable reviewed this plan on 2026-10-24, and its findings, verified in code, are folded in.

## The first host

| | Realty On Record (`portal_he_ui`) |
|---|---|
| Frontend | TanStack Start, TanStack Query/Form/Table, shadcn (Radix and Tailwind) |
| API | Hono (`@hono/zod-openapi`) Worker `realty-api`, built with `tsc` (no bundler), on the **portal-tech** Cloudflare account |
| DB | PlanetScale MySQL through Prisma, `relationMode = "prisma"`. Schema changes go through **`prisma db push`** plus hand-written SQL |
| Auth | better-auth. `user.role === "admin"` means all companies. Each request is scoped to **one** company (`X-Company-Id`) or **one** tenant (`X-Tenant-Id`) |

## Architecture: two Workers, one database

```
 customer mail ──► Email Routing ──► helpdesk Worker  (our package, deployed in the HOST's CF account)
                                     email() → Workflow → hd_* tables + R2 + ack
                                     /api/*  agent API
                                            ▲ service binding (never reachable from the internet)
 browser ─► Realty UI (TanStack Start) ─► realty-api (Hono)
                                     /api/v1/helpdesk/* → better-auth session + company context
                                     → trusted principal → env.HELPDESK.fetch()
```

- **The help desk Worker keeps mail, R2, the Workflow, AI and Email Sending.** `realty-api` needs only one service binding.
- **The tables live in the host's database** with a prefix (`hd_*`), so Realty can join and report on them.
- **The host API is the auth boundary.** Over the binding it passes a trusted principal. Two reasons to prefer the binding over running in-process:
  - `realty-api` has no R2, AI or Workflow bindings and no bundler;
  - the help desk can be upgraded without redeploying the host.
  
  In-process mode stays documented as an option.
- **Hard constraint:** service bindings and Email Routing both require the same Cloudflare account as `realty-api` and the support zone. So Realty gets its **own deployment** in the portal-tech account, created by the packaged CLI. ihms.dev stays the dev deployment and the CI target.

## Schema ownership (the main risk)

Realty runs `prisma db push`, sometimes with `--force-reset` on dev branches. That emits `DROP TABLE` for any table missing from `schema.prisma`, and a deploy request from such a branch would carry the drop to production. Unknown `hd_*` tables would be destroyed.

Rules:
1. **The host owns DDL on the host DB.** The help desk Worker never runs migrations there.
2. Each help desk version ships, per prefix:
   - `migrations/mysql/*.sql`;
   - a generated **Prisma schema file** `prisma/helpdesk.prisma`, created from the same Kysely migration definitions and placed in a multi-file `prismaSchemaFolder`.
3. Realty applies the SQL through its normal PlanetScale deploy-request path, then runs `cf-helpdesk migrate --record-only`.
4. The Prisma models are documented as **read-only from Prisma**: writes go through the help desk API.
5. `cf-helpdesk upgrade` prints the pending SQL and the Prisma file delta.
6. A CI test runs a MySQL container: `prisma db push` of a host schema plus the fragment, then asserts that every `hd_*` table survives.

## Phases

### H1: make it embeddable (this repo) ✅ built (branch `feat/headless-h1`)

Factory, prefixing, partitions, trusted principal, agent events and attachments are all done. The host guide is [EMBEDDING.md](EMBEDDING.md). Two deviations from the list below:
- Agent-action events reuse the existing Workflow (a `kind: "agent-events"` payload), so no new binding is needed.
- The Prisma file is still manual (documented); its generation moves to `cf-helpdesk init` in H2.
1. **Factory.** Today `api.ts` is a module-level `new Hono()` with an ambient `Env`. Replace it with `createHelpdesk(config) → { fetch, email, InboundEmailWorkflow }`. Config (prefix, driver, auth modes) is passed in, and `apps/worker` becomes a three-line consumer.
2. **Prefix everything.**
   - Tables, index names (global on SQLite/Postgres) and the `_helpdesk_migrations` table.
   - The one raw SQL subquery (`repo.ts:701`, `counters`) moves to a Kysely subselect.
   - A shared `tables(prefix)` helper serves both the repo and the migrations; `compileMigrations(dialect, prefix)` generates the SQL.
   - Add `--table-prefix` to setup and migrate.
3. **Partitioning.** Add a `partition` column on mailboxes, tickets and agents (not `scope`, which `counters` already uses). The principal carries a single `partition: string | null`, where null means unrestricted, matching Realty's admin. Filter in the list, detail and every mutation. Tickets inherit the partition from their mailbox. Contacts stay global (email is unique), so a later requester view filters by ticket partition, never by contact.
4. **Trusted-principal auth.**
   - **Header:** `X-Helpdesk-Principal` (`externalId`, `email`, `name`, `role`, `partition`).
   - **When it's honoured:** only when `TRUSTED_PRINCIPAL` is on and `X-Helpdesk-Service-Key` matches (`secretsEqual`), and only via the binding. The Worker has no public route for it. This mirrors Realty's own `X-Internal-Key`.
   - **Agents:** `agents.external_id`, with a just-in-time upsert that **re-syncs name and role on every request**.
   - **Principal kind:** `requester` is reserved for later.
5. **Events from agent actions.** Run the plugin bus inside API requests and add `ticket.replied`, `ticket.assigned` and `ticket.status_changed`, for Realty notifications and webhooks.
6. **Attachments API.** `GET /api/attachments/:id` streams from R2, with the partition check.

### H2: SDK, CLI and reference app ✅ built (branch `feat/headless-h2`)

Built:
- `@cf-helpdesk/client` (plus `/server`: `forwardToHelpdesk`, `trustedHeaders`);
- `cf-helpdesk init` and `cf-helpdesk migrate`;
- the generated Prisma models, verified on MySQL with Prisma 6;
- `examples/tanstack-start` with a headless-Chrome E2E in CI.

Not yet: `@cf-helpdesk/hono` (`forwardToHelpdesk` covers it in about 5 lines); npm publishing (packages are still private; `init --deps file` links a checkout).
- **`@cf-helpdesk/client`**: a framework-agnostic typed fetch client (types from the API's zod schemas). It works in browsers, Workers and Node.
- **`@cf-helpdesk/hono`**: `helpdeskProxy({ binding, resolvePrincipal })`. Other frameworks use the client plus a short proxy example.
- **`cf-helpdesk` CLI** (one bin):
  - `init` writes `helpdesk/` into the host repo: `wrangler.jsonc`, `worker.ts`, `helpdesk.config.ts`, the SQL and the Prisma file;
  - `setup` provisions resources (the existing logic) with `--table-prefix`;
  - `migrate` and `upgrade`.
- **`examples/tanstack-start`**: an unstyled reference app with 4 routes (inbox, ticket, reply/note, assign) on `client`. It runs in **CI** against the local Worker with a fake trusted principal. This is the end-to-end test of the exact contract Realty uses.
- Publish to npm with changesets. The scope name is still to be decided.

### H3: Realty On Record integration
- `cf-helpdesk init` in `portal_he_ui`. Deploy into the portal-tech account with `hd_*` tables in Realty's PlanetScale, applying the SQL by deploy request.
- `realty-api` mounts `/api/v1/helpdesk/*`: the better-auth session plus company/tenant context becomes the principal, sent through the binding.
- Realty screens use Realty's own shadcn components with TanStack Query over `@cf-helpdesk/client`. `@cf-helpdesk/react` hooks get extracted from this work only if they prove reusable.
- Live test: real mail to the Realty support address → ticket in the right company → reply from Realty's UI arrives threaded.

### H4: standalone applet (later)
- A **TanStack Start** app with **better-auth**, built only on `@cf-helpdesk/client`.
- Framework-agnostic embedding: an **iframe route** with a short-lived signed handoff token from the host. A web component is deferred until a non-React host actually needs one, because it would be a second render stack to maintain.

## Full UI first?
No. A styled UI now tests presentation, not integration, and Realty would throw it away. The reference app in H2 gives us end-to-end coverage of the real contract. The Prisma/MySQL CI test covers what no UI can: whether the prefixed tables survive the host's tooling.

## Open questions (needed by H3, not H1)
- The Realty support address and zone. Is the zone on the portal-tech account?
- Partition key: one per Company, or also per Tenant? Should tenants see their own tickets (requester portal)?
- Which Realty roles map to `admin` and `agent`?
- npm scope (`@cf-helpdesk` or `@portal-tech`?) and the repo's license.
