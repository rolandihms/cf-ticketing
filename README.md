# CF Helpdesk

An open-source help desk and ticketing system that runs entirely on Cloudflare.

Email arrives at `support@yourdomain.com` and Cloudflare Email Routing hands it to a Worker. The Worker starts a durable **Workflow**, which:

1. Stores the message in R2.
2. Creates a ticket with a reference such as `ACME-000123` (or threads the message onto an existing ticket).
3. Emails the customer an acknowledgement that carries the ticket number.
4. Runs your **plugins**: AI classification, GitHub issues, webhooks or anything else.

> Status: **Phase 1 in progress.** Inbound → ticket → ack → plugins works locally and is covered by tests. See [docs/PLAN.md](docs/PLAN.md) and [docs/SPIKES.md](docs/SPIKES.md).

## Stack

- **Cloudflare Workers + Email Routing** for inbound mail; the `addresses` key in `wrangler.jsonc` creates the routing rule on deploy.
- **Cloudflare Workflows** for retries, idempotency and long-running extensions.
- **Email Service (Email Sending)** for acknowledgements and replies to any recipient. Workers Paid is required, and the product is in beta. There is a fallback, `ACK_MODE=reply`, for the Free plan.
- **D1** as the default database, accessed through **Kysely**. Postgres, MySQL and PlanetScale via Hyperdrive or HTTP drivers are planned for Phase 2.
- **R2** for raw emails, bodies and attachments.

## Layout

```
packages/core     runtime-agnostic logic: guards, threading, refs, ingest keys, plugin API
apps/worker       the deployable Worker (email handler, Workflow, REST API, D1 repo)
  helpdesk.config.ts   ← your plugins and settings
  migrations/          D1 SQL migrations
docs/             plan, spikes, design notes
```

## Local development

```bash
npm install
cd apps/worker
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
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

## Deploying to your own account

See [docs/SPIKES.md](docs/SPIKES.md#procedure-for-spikes-1-and-3-about-15-minutes-on-a-real-domain) for the manual steps. An interactive `npm run setup` script will automate them.

## License

MIT
