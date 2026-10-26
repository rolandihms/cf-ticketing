# Reference UI (TanStack Start, unstyled)

A minimal agent UI for the headless help desk, built only on [`@rolandihms/helpdesk-client`](../../packages/client). It shows how a host app embeds the help desk ([docs/EMBEDDING.md](../../docs/EMBEDDING.md)):

```
browser ─► this app (TanStack Start on Workers) ─► /api/helpdesk/* ─► forwardToHelpdesk() ─► HELPDESK service binding ─► help desk Worker
                     session cookie → HostIdentity          (X-Helpdesk-Service-Key + X-Helpdesk-Principal)
```

- `src/lib/identity.ts` is the **stand-in for your auth**: a cookie picks a demo user, such as staff who see every company, or an agent for one company. Replace it with your session lookup.
- `src/routes/api/helpdesk.$.ts` is the whole server side: about 15 lines.
- `src/routes/index.tsx` is the inbox, and `src/routes/tickets.$ref.tsx` is the ticket view. Both use plain HTML, so your components drop in.

## Run it locally

```bash
cp examples/tanstack-start/.dev.vars.example examples/tanstack-start/.dev.vars
cd apps/worker && npx wrangler d1 migrations apply DB --local
npx wrangler dev --local --var TRUSTED_PRINCIPAL:on --var HELPDESK_SERVICE_KEY:dev-service-key --var API_TOKEN:dev-token
```

In a second terminal:

```bash
npm run dev -w examples/tanstack-start          # http://localhost:5173
```

The service binding reaches the local help desk through Wrangler's dev registry. Then create a mailbox and send a test email:

```bash
curl -X POST localhost:8787/api/mailboxes -H 'authorization: Bearer dev-token' -H 'content-type: application/json' \
  -d '{"address":"support@acme.example","name":"Acme Support","refPrefix":"ACME","partition":"company:acme"}'
printf 'From: jane@cust.example\r\nTo: support@acme.example\r\nSubject: Gate remote broken\r\n\r\nIt stopped working.\r\n' |
  curl -X POST 'localhost:8787/cdn-cgi/handler/email?from=jane@cust.example&to=support@acme.example' --data-binary @-
```

`--local` turns off Workers AI, so classification falls back to the rules and `other`. Drop the flag (and log in) to classify with the LLM.

## E2E

`npm run e2e -w examples/tanstack-start` does all of the above, then drives headless Chrome through the flow:
1. Assign the ticket, reply, and add a note.
2. Check that another tenant can't see the ticket.

CI runs it on every pull request (`.github/workflows/e2e.yml`).
