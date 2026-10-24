# CF Helpdesk

[![CI](https://github.com/rolandihms/cf-ticketing/actions/workflows/ci.yml/badge.svg)](https://github.com/rolandihms/cf-ticketing/actions/workflows/ci.yml)

An open-source help desk and ticketing system that runs entirely on Cloudflare.

Email arrives at `support@yourdomain.com` and Cloudflare Email Routing hands it to a Worker. The Worker starts a durable **Workflow**, which:

1. Stores the message in R2.
2. Creates a ticket with a reference such as `ACME-000123` (or threads the message onto an existing ticket).
3. Emails the customer an acknowledgement that carries the ticket number.
4. Runs your **plugins**: AI classification, GitHub issues, webhooks or anything else.

> Status: **working end to end on a live domain.** Inbound email → ticket → acknowledgement → AI classification → optional GitHub issue and webhooks, plus an [agent API](docs/AGENT-API.md). It can run **headless inside your own app**, with prefixed tables in your database, your login, and per-tenant partitions: see [docs/EMBEDDING.md](docs/EMBEDDING.md). Next: an SDK and `cf-helpdesk init`, then a UI. See [docs/HEADLESS-PLAN.md](docs/HEADLESS-PLAN.md).

## Deploy to your Cloudflare account (5 minutes)

```bash
git clone https://github.com/rolandihms/cf-ticketing && cd cf-ticketing
npm install
npx wrangler login
npm run setup
```

`npm run setup` asks for your support address and creates everything it needs:
- Email Routing and Email Sending on your domain
- a D1 database, an R2 bucket and the Worker
- the routing rule for your address
- an API token
- your first mailbox

It never changes existing MX records without asking. See [docs/SETUP.md](docs/SETUP.md) for options, Postgres/MySQL, and running several help desks on one account.

## Stack

- **Cloudflare Workers + Email Routing** for inbound mail; the `addresses` key in `wrangler.jsonc` creates the routing rule on deploy.
- **Cloudflare Workflows** for retries, idempotency and long-running extensions.
- **Email Service (Email Sending)** for acknowledgements and replies to any recipient. Workers Paid is required, and the product is in beta. There is a fallback, `ACK_MODE=reply`, for the Free plan.
- **D1** as the default database, or **Postgres / MySQL / PlanetScale** through Hyperdrive or HTTP drivers. One schema is defined in Kysely and compiled to SQL for each backend; see [docs/DATABASE.md](docs/DATABASE.md).
- **R2** for raw emails, bodies and attachments.

## Layout

```
packages/cli      `npm run setup`: provisions + deploys to your Cloudflare account
packages/core     runtime-agnostic logic: guards, threading, refs, ingest keys, plugin API
packages/plugins  optional integrations: GitHub issues, signed webhooks (docs/INTEGRATIONS.md)
packages/db       portable schema + generated SQL (sqlite/postgres/mysql), repos, migrate CLI
apps/worker       the deployable Worker (email handler, Workflow, REST API, D1 repo)
  helpdesk.config.ts   ← your plugins and settings
docs/             plan, spikes, design notes
```

## Local development

```bash
npm install
cd apps/worker
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local   # uses packages/db/migrations/sqlite
npx wrangler dev
```

Create a mailbox, then send a test email:

```bash
curl -X POST localhost:8787/api/mailboxes -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"address":"support@acme.test","name":"Acme Support","refPrefix":"ACME"}'

curl -X POST 'localhost:8787/cdn-cgi/local/email?from=jane@cust.example&to=support@acme.test' \
  --data-binary @test.eml

curl localhost:8787/api/tickets/ACME-000001 -H 'authorization: Bearer dev-token'
```

Run the tests from the repo root with `npm test`. Core unit tests run in Node; the Worker integration tests run in workerd and exercise the email handler, the Workflow and D1.

## Writing a plugin

```ts
import type { HelpdeskPlugin } from "@cf-helpdesk/core";

export const slackNotify: HelpdeskPlugin<Env> = {
  name: "slack-notify",
  async onTicketCreated(ctx) {
    // Side effects go in ctx.step.do(): it is retried and runs once even when the Workflow replays.
    await ctx.step.do("post", async () => {
      await fetch(ctx.env.SLACK_WEBHOOK, { method: "POST", body: JSON.stringify({ text: `New ticket ${ctx.ticket.ref}` }) });
    });
  },
};
```

Register the plugin in `apps/worker/helpdesk.config.ts`. If a plugin fails, the failure is recorded on the ticket, and the ticket's Workflow keeps going.


## License

MIT
