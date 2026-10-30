# Standalone desk

A complete help desk in one Worker: the agent API and a React UI on the same origin, with Cloudflare Access
for sign-in. Use it when you don't have a host app to embed the help desk in ([docs/EMBEDDING.md](../../docs/EMBEDDING.md)).

```
browser ─► Cloudflare Access ─► Worker ─┬─ /api/*, /health ─► help desk API (verifies the Access JWT)
                                        └─ everything else ─► static UI (Vite + React, SPA fallback)
mail ─► Email Routing ─► same Worker (email handler) ─► Workflow ─► tickets
```

- `src/worker.ts` is the whole server: `createHelpdesk(config)` plus the static assets.
- `src/ui` is the UI: inbox views, ticket conversation (reply, internal note, status, priority and assignee), and admin settings for agents and mailboxes. It uses only [`@rolandihms/helpdesk-client`](../../packages/client).
- `helpdesk.config.ts` has classification and plugins. There are no integrations by default.

## Run it locally

```bash
cp apps/desk/.dev.vars.example apps/desk/.dev.vars     # set DEV_AGENT_EMAIL to your address
cd apps/desk && npx wrangler d1 migrations apply DB --local
npm run dev                                             # http://localhost:5173
```

There is no Access locally. `.dev.vars` signs every localhost request in as `DEV_AGENT_EMAIL`, an admin (`src/dev-identity.ts`). It takes effect only for localhost hosts and only when all three dev variables are set, so never put them in `wrangler.jsonc` or deployed secrets.

Add a mailbox under **Settings**, then send it mail:

```bash
printf 'Authentication-Results: mx.cloudflare.net; dmarc=pass\r\nFrom: jane@customer.example\r\nTo: support@help.example.com\r\nSubject: Login broken\r\n\r\nIt says my password is wrong.\r\n' |
  curl -X POST 'localhost:5173/cdn-cgi/handler/email?from=jane@customer.example&to=support@help.example.com' --data-binary @-
```

Use `dmarc=fail` to see how a forged sender looks. Workers AI is off locally, so classification falls back to the rules.

## Deploy

1. Copy `wrangler.jsonc` to `wrangler.<profile>.jsonc` (gitignored). Set `name`, `account_id`, `routes` (a custom domain, e.g. `{ "pattern": "support.example.com", "custom_domain": true }`) and `"workers_dev": false`.
2. Create the D1 database and R2 bucket, and put their names and id in the profile:
   ```bash
   npx wrangler d1 create <name>
   npx wrangler r2 bucket create <name>-mail
   ```
3. Apply migrations **before** the first deploy (export `CLOUDFLARE_ACCOUNT_ID` so wrangler doesn't silently pick another account):
   ```bash
   npx wrangler d1 migrations apply DB --remote -c wrangler.<profile>.jsonc
   ```
4. In Zero Trust, create a self-hosted Access application for the whole hostname, with a policy that allows your agents. Copy its team domain and **Application Audience (AUD) tag** into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
5. Add the first admin. Access blocks everything else, so do it in D1 directly:
   ```bash
   npx wrangler d1 execute DB --remote -c wrangler.<profile>.jsonc --command \
     "insert into agents (id, email, name, role, active, created_at) values ('admin-1', 'you@example.com', 'You', 'admin', 1, unixepoch() * 1000)"
   ```
   Everyone else is added in **Settings → Agents**.
6. Build and deploy:
   ```bash
   WRANGLER_CONFIG=wrangler.<profile>.jsonc npm run deploy
   ```
7. Receive mail: add `"addresses": ["support@help.example.com"]` to the profile, so `wrangler deploy` creates the Email Routing rules, and add that address as a mailbox in **Settings**. If the domain's mail is hosted elsewhere (Google Workspace, Microsoft 365), use a subdomain such as `help.example.com` and enable Email Routing for that subdomain only. That adds MX records to the subdomain and leaves the apex's MX alone.

   When Email Routing has never been set up for the apex, the dashboard won't offer subdomains, and `wrangler email routing enable` only takes a whole zone. Enable the subdomain through the API instead, then add the rule with wrangler (no `addresses` in the profile):

   ```bash
   # Records it will add (all on the subdomain):
   curl -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/dns?subdomain=help.example.com"
   curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/dns" -d '{"name":"help.example.com"}'
   npx wrangler email routing rules create example.com --match-type literal --match-field to \
     --match-value support@help.example.com --action-type worker --action-value <worker-name>
   npx wrangler email sending enable help.example.com   # replies and acknowledgements
   ```

   Afterwards the dashboard shows the apex's Email Routing as "misconfigured", because its MX still points at your mail host. That is expected: never accept its offer to add or fix the apex records.

Acknowledgements and replies use Email Sending, which needs Workers Paid. Set `ACK_MODE` to `"reply"` on the Free plan, or to `"off"`.
