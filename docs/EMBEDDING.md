# Embedding the help desk in another application

The help desk can run **headless** inside an existing product. Your app keeps its own UI, login and database. The help desk handles mail, tickets, classification and replies. The plan and its phases are in [HEADLESS-PLAN.md](HEADLESS-PLAN.md).

```
 customer mail ──► Email Routing ──► help desk Worker (createHelpdesk)  ── hd_* tables in YOUR database
                                            ▲ service binding
 browser ──► your app ──► your API ─────────┘  X-Helpdesk-Service-Key + X-Helpdesk-Principal
```

## 0. Quick start: `cf-helpdesk init`

In your project's root:

```bash
npx @rolandihms/helpdesk-cli init --db planetscale --table-prefix hd_
```

The packages are on npm as `@rolandihms/helpdesk-{core,db,plugins,worker,client,cli}`. They ship ES modules for bundlers (Wrangler, Vite), with TypeScript declarations for `"moduleResolution": "bundler"`. From a checkout of this repo, `npm run cli -- init --cwd ../your-app …` links the checkout instead (`file:` dependencies).

This writes:
- `helpdesk/`: a small Worker package (`createHelpdesk`, config, wrangler.jsonc with `TABLE_PREFIX`, `TRUSTED_PRINCIPAL=on` and `workers_dev: false`) plus `README.md` with the deploy steps;
- `helpdesk/migrations/<dialect>/*.sql`: the prefixed schema, which you apply with your own process;
- `<your prisma folder>/helpdesk.prisma`: generated models, so `prisma db push` keeps the tables. This is for MySQL/PlanetScale, when a single `schema.prisma` is found; otherwise pass `--prisma-dir`.

Re-run `init` after upgrading. Generated files are refreshed; the files you edit are kept (`--force` overwrites them). `npx @rolandihms/helpdesk-cli migrate --driver mysql --table-prefix hd_ [--record-only]` applies or records the SQL.

Sections 1–6 explain what `init` sets up. [examples/tanstack-start](../examples/tanstack-start) is a working host app.

## 1. The help desk Worker

The Worker is a library: `@rolandihms/helpdesk-worker`. Your Worker's entry point is three lines:

```ts
import { createHelpdesk } from "@rolandihms/helpdesk-worker";
import config from "./helpdesk.config";

const helpdesk = createHelpdesk({ ...config, tablePrefix: "hd_" });
export const InboundEmailWorkflow = helpdesk.InboundEmailWorkflow;
export default { fetch: helpdesk.fetch, email: helpdesk.email };
```

It needs the bindings listed in `HelpdeskEnv` (`packages/worker/src/env.ts`): `MAIL` (R2), `EMAIL` (Email Sending), `INBOUND_WORKFLOW`, and the database. Use `apps/worker/wrangler.jsonc` as the template.

**Forged senders:** inbound mail is trusted as coming from its `From:` address only when Email Routing's `Authentication-Results` header says `dmarc=pass`. Mail without that still opens a ticket, but it gets no acknowledgement (so a forged address can't be used to make you send mail) and can't join an existing ticket by quoting its ref. The verdict is shown to agents as `sender_verified` on each message. Set `requireDmarc: false` in the config only if your mail doesn't arrive through Cloudflare Email Routing.

**Same account:** service bindings and Email Routing only work within one Cloudflare account. The help desk Worker must therefore live in the same account as your app's Worker and your support domain's zone.

## 2. Tables in your database: the prefix

Give every help desk table and index a prefix so the help desk can't collide with your tables. For example, with `hd_` you get `hd_tickets` and `hd_tickets_status_idx`. The migrations table is prefixed too.

- Set the prefix with **`createHelpdesk({ tablePrefix })`** or the `TABLE_PREFIX` var. It must match the prefix the migrations were generated with.
- **Render the SQL** for your database:
  ```bash
  npm run db:generate -- --table-prefix hd_ --dialect mysql --out ../your-app/helpdesk/migrations
  ```
- **Apply it** as follows:
  - **Directly:** `npm run db:migrate -- --driver mysql --table-prefix hd_` (Postgres works the same way).
  - **Through your own migration process** (for example a PlanetScale deploy request): apply the SQL there, then record it with `npm run db:migrate -- --driver mysql --table-prefix hd_ --record-only`.
- `npm run setup -- --table-prefix hd_` does all of this for a fresh deployment (D1, Postgres, MySQL).

### Rule: your app owns the DDL

**The help desk Worker never changes your schema at runtime.** Help desk upgrades ship new migrations. Apply them with your normal process, before deploying the new Worker.

### Prisma users: protect the tables

`prisma db push` (and `migrate dev` with a reset) **drops tables that aren't in `schema.prisma`**. A deploy request from such a branch carries the drop to production. `cf-helpdesk init` therefore writes `helpdesk.prisma` next to your schema.

- The file is generated from the same migration definitions as the SQL. CI checks it on MySQL with Prisma 6:
  - **Without the file**, `prisma migrate diff` would drop `hd_tickets`.
  - **With it**, `db push` changes nothing, and the diff against a migrated database is empty.
- Prisma must load the **whole folder**, as a multi-file schema (Prisma 6.6+). Use `--schema prisma` or `"prisma": { "schema": "prisma" }` in package.json.
- The models are **read-only** from Prisma (for reports and joins). Make every write through the help desk API, which keeps events, counters and threading consistent.
- Column types, unique/index names and nullability match the database exactly. Model names get a prefix (`HdTickets`; change it with `--model-prefix`).

## 3. Calling the API from your app: the trusted principal

Your API has already authenticated the user, so it tells the help desk who they are. Enable this mode on the help desk Worker:

```jsonc
"vars": { "TRUSTED_PRINCIPAL": "on" }
```

```bash
npx wrangler secret put HELPDESK_SERVICE_KEY     # a long random value, shared with your app
```

In your app's `wrangler.jsonc`, bind the help desk:

```jsonc
"services": [{ "binding": "HELPDESK", "service": "cf-helpdesk" }]
```

Then forward requests from your API. `forwardToHelpdesk()` from `@rolandihms/helpdesk-client/server` does it for any Request/Response framework (Hono, TanStack Start, Next.js…). It also drops client-sent identity headers and cookies:

```ts
import { forwardToHelpdesk } from "@rolandihms/helpdesk-client/server";

app.all("/api/v1/helpdesk/*", (c) =>
  forwardToHelpdesk(c.req.raw, {
    target: c.env.HELPDESK,                        // the service binding
    serviceKey: c.env.HELPDESK_SERVICE_KEY,
    mountPath: "/api/v1/helpdesk",                 // ↦ the help desk's /api
    identity: {
      externalId: c.get("user").id,
      email: c.get("user").email,
      name: c.get("user").name,
      role: c.get("user").role === "admin" ? "admin" : "agent",
      partition: c.get("user").role === "admin" ? null : `company:${c.get("companyId")}`,
    },
  }),
);
```

In the browser (or on your server), use the typed client against that mount:

```ts
import { createHelpdeskClient } from "@rolandihms/helpdesk-client";
const helpdesk = createHelpdeskClient({ baseUrl: "/api/v1/helpdesk" });
const { tickets } = await helpdesk.tickets.list({ status: ["new", "open"], assignee: "me" });
await helpdesk.tickets.reply("ACME-000123", { text: "On it!", idempotencyKey: crypto.randomUUID() });
```

The same thing written by hand (Hono):

```ts
app.all("/api/v1/helpdesk/*", async (c) => {
  const user = c.get("user");                     // from your auth (better-auth, …)
  const company = c.get("companyId");             // your tenancy context
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/api/v1/helpdesk", "/api");
  const req = new Request(url, c.req.raw);
  req.headers.set("x-helpdesk-service-key", c.env.HELPDESK_SERVICE_KEY);
  req.headers.set("x-helpdesk-principal", JSON.stringify({
    externalId: user.id,
    email: user.email,
    name: user.name,
    role: user.role === "admin" ? "admin" : "agent",
    partition: user.role === "admin" ? null : `company:${company}`,  // null = every partition
  }));
  req.headers.delete("cookie");                    // the help desk doesn't need your session
  return c.env.HELPDESK.fetch(req);
});
```

**Security:**
- The header is honoured only when `TRUSTED_PRINCIPAL=on` **and** the service key matches. The key is compared in constant time and checked before anything else.
- Keep the help desk's API off the public internet if you can. Set `"workers_dev": false` and add no routes, because Email Routing doesn't need one. The binding still works.
- Never forward a client-supplied `X-Helpdesk-*` header. Always set both headers yourself.

**Identity:**
- `partition` is **required**. Use `null` only for staff who may see every partition.
- The help desk creates an agent for each `externalId` on first use. It **re-syncs** email, name and role on every request, because your app is the source of truth. It also reactivates an agent that was deactivated.
- An existing agent with the same email and no `externalId` is linked to it. If the email belongs to a different external user, or a re-synced email clashes with another agent, the API answers `409`.
- **The host wins.** Changes made through `PATCH /api/agents` to a host-provisioned agent's role, name or active flag are overwritten on that user's next request. The last-admin guard doesn't apply to these agents.
- Host-provisioned agents sign in through your app only. Cloudflare Access sign-in is refused for them, because their partition comes from your app per request.

## 4. Partitions (multi-tenancy)

A partition is an opaque string you choose, for example `company:42`.

- **Mailboxes:** `POST /api/mailboxes {…, "partition": "company:42"}` assigns one. Every ticket created through the mailbox inherits its partition.
- **Restricted callers:** a caller with a partition sees only that partition's tickets, mailboxes and messages. Anything else answers `404`.
- **Host-provisioned agents** are workable in a partition for 30 days after the host last sent them there (refreshed on use). Sending one with a partition withdraws the global (`partition: null`) grant.
  - It may assign only agents who are global or in the ticket's partition.
  - A restricted admin creates and manages agents only in its own partition.
- **Unrestricted callers** (`partition: null`, or the API token) see everything. They can narrow a list with `GET /api/tickets?partition=company:42`.
- **Agents:** an agent created in the help desk with a partition is restricted to it. A host-provisioned agent belongs to every partition your app has sent with that user (`partition: null` means all of them). It is listed and assignable only there, so one tenant never sees another tenant's staff.
- **Contacts** (customers) are global by email. One customer writing to two companies is one contact with tickets in two partitions.

## 5. Events for your app

Agent actions raise events that plugins receive in `onEvent`: `ticket.status_changed`, `ticket.priority_changed`, `ticket.assigned`, `ticket.replied` and `ticket.note_added`. Inbound mail raises `ticket.created`, `message.received` and `ticket.classified`.

- Delivery runs durably and with retries in the help desk's Workflow, so the API response isn't slowed down.
- **To notify your app,** subscribe a [signed webhook](INTEGRATIONS.md) to the types you need:
  ```ts
  webhooks({ endpoints: [{ name: "app", url: (env) => env.WEBHOOK_URL, secret: (env) => env.WEBHOOK_SECRET,
    events: ["ticket.created", "ticket.assigned", "ticket.replied", "ticket.status_changed"] }] })
  ```
- Each event carries `ticketRef` and `actor` (`agent:<id>`; map it back with `GET /api/agents`, where `externalId` is your user id). Dedupe on the delivery id.

## 6. Attachments

`GET /api/tickets/:ref` lists `attachments` (id, filename, MIME type, size). `GET /api/attachments/:id` downloads one. It is always served as a download, with `nosniff` and a sandboxing CSP, so hostile HTML can't run on your origin. Partition rules apply.

## 7. Requesters: customers in your app

Your customers can raise tickets, follow them and reply without email. Your backend forwards their requests with a **requester** identity:

```ts
forwardToHelpdesk(c.req.raw, {
  target: c.env.HELPDESK, serviceKey: c.env.HELPDESK_SERVICE_KEY, mountPath: "/api/v1/support",
  identity: { externalId: user.id, email: user.email, name: user.name, role: "requester",
    partition: `company:${user.companyId}`, visibility: user.isCompanyAdmin ? "partition" : "own" },
});
```

- **A requester is a contact, never an agent.** It isn't listed, assigned or counted as staff, so a staff member who also raises tickets doesn't collide with their agent record.
- **Contacts follow your user id.** The first request links the contact with that email (mail they sent before signing up becomes theirs). When the user's email changes, the same contact moves with it, and an older contact that only had the new address is merged in. An email that belongs to another user id answers `409`.
- **What a requester can call.** Everything else answers `403`:

| Method & path | What |
|---|---|
| `GET /api/me` | The requester, its partition and visibility |
| `GET /api/tickets` | Its tickets (`status`, `limit`, `cursor` filters) |
| `POST /api/tickets` `{mailbox, subject, text, metadata?, source?, ack?}` | Raise a ticket in its own partition. Send `Idempotency-Key`. |
| `GET /api/tickets/:ref` | `{ticket, messages}`: the public side only |
| `POST /api/tickets/:ref/messages` `{text}` | Reply. Reopens a pending or solved ticket. Send `Idempotency-Key`. No email goes out. |
| `GET /api/messages/:id/text`, `GET /api/attachments/:id` | Bodies and files of public messages |

- **Visibility.** `"own"` (the default) sees the tickets the contact raised. `"partition"` also sees every ticket in its partition, e.g. a company admin following their tenants' tickets. A reply records who posted it.
- **Only proven requesters.** A ticket is shown only if its requester was verified: raised through your app, or mail that passed DMARC. A forged email "from" your user never appears in their portal. Customer emails that failed DMARC are left out of a visible ticket too. Tickets from before 0.2.0 count as unverified.
- **Public side only.** Requesters see the subject, status, source, metadata, and customer messages, acknowledgements and agent replies with their attachments. Never notes, events, classifications, the assignee or priority. Authors appear by **name only**: no email address is returned.
- **The same pipeline as mail.** Tickets and replies from your app run through the help desk's Workflow: the ticket gets the next ref, is classified, the mailbox's notify list is emailed, and plugins and webhooks see `ticket.created`, `message.received` and `ticket.classified`. An acknowledgement email goes out only with `ack: true`.
- **Metadata** is up to 20 string pairs you attach (e.g. `{"realty.siteId": "42"}`). Set it when raising a ticket, or later with `PATCH /api/tickets/:ref` as staff. It's returned to staff, requesters and webhooks.
- **Moving tickets between tenants.** An unrestricted admin can `PATCH {partition}`, e.g. to give a company a ticket that arrived by email.
- The client has a `requester` namespace: `helpdesk.requester.list()`, `.get(ref)`, `.create({...})`, `.reply(ref, {...})`.

