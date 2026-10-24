# Setup: deploying CF Helpdesk to your Cloudflare account

```bash
npm install
npx wrangler login
npm run setup
```

## Prerequisites

- A Cloudflare account, with your domain added as a **zone** (Cloudflare nameservers).
- **Workers Paid** ($5/month), if you want acknowledgements sent to *any* customer address. This is the default, `--ack-mode send`. On the Free plan, choose `--ack-mode reply`. That replies with `message.reply()` and only works for senders whose mail passes DMARC. Setup can't detect your plan, but it stops safely if Email Sending is refused.
- Node 20+.

## What `npm run setup` does

Setup runs in three phases. Every question is asked **before** anything changes. Changes that affect live mail come **last**, so a failure part-way never leaves your domain's mail broken. Every step checks the existing state first, so **re-running is safe**: it reuses resources, keeps the same API token, and keeps every address already in the profile.

**1. Checks and questions. Nothing is changed yet.**
- Checks your login and asks which account, if your login has several.
- Finds the domain's Cloudflare zone, walking up from subdomains (`help.acme.com` → `acme.com`).
- Checks the MX records. **Enabling Email Routing replaces the zone's MX records**, so if the domain already receives mail elsewhere (Google Workspace, Microsoft 365…), setup lists those hosts and asks. Non-interactive runs need `--replace-mx`; `--yes` alone never replaces MX records.
- Checks whether the address is already routed to another Worker. If so, it asks; `--yes` approves this.

**2. Reversible provisioning**
- Enables **Email Sending** (for `--ack-mode send`). On the Free plan this fails here with a hint to use `--ack-mode reply`, before mail routing is touched.
- Creates the database: D1, or a Hyperdrive config for Postgres/MySQL.
- Creates the R2 bucket.
- Writes `apps/worker/wrangler.<profile>.jsonc`. This is the template with your values filled in and the comments kept; it is gitignored.
- Writes `apps/worker/.helpdesk/<profile>.env` with a generated `API_TOKEN`. The file is mode 600 and gitignored.
- Applies migrations. `--config-only` stops here.

**3. Live changes**
- Enables Email Routing on the zone, if needed.
- If you approved a re-route, removes the old rule for the address.
- Deploys. The `addresses` key creates the routing rules.
- Sets the `API_TOKEN` secret (piped through stdin, never passed as an argument), plus `DATABASE_URL` for PlanetScale.
- Creates the mailbox through the REST API.

**After setup, wait 1–2 minutes before sending the first test email.** A brand-new routing rule takes a moment to take effect. Until then, the domain's catch-all rule may silently drop mail; we hit this in testing.

### Subdomain addresses (recommended if the domain already has mail)

Cloudflare only lets you switch on Email Routing for a subdomain in the dashboard. Do that once:

1. Go to Cloudflare dashboard → your zone → **Email → Email Routing → Settings → Subdomains**.
2. Add `help.acme.com`. Cloudflare adds MX records for the subdomain only, so mail at `acme.com` is unaffected.
3. Run `npm run setup -- --address support@help.acme.com`.

Setup checks that the subdomain's MX records point to Cloudflare. If they don't, it stops and prints these steps. It never changes the apex domain's MX records for a subdomain address.

## Options

```
--address <email>        Support address (e.g. support@acme.com)
--name <text>            Name shown in replies (default "<Domain> Support")
--ref-prefix <ABC>       Ticket prefix: ACME → ACME-000123
--worker <name>          Worker name; also prefixes the D1/R2/Workflow names (default cf-helpdesk)
--profile <name>         Config file suffix (default: from the domain)
--account-id <id>        Cloudflare account id
--ack-mode send|reply|off
--db d1|postgres|mysql|planetscale
--database-url <url>     For postgres/mysql/planetscale
--config-only            Create resources and write the config; don't migrate, deploy or touch mail routing
--yes                    Non-interactive: accept defaults; allow re-routing an address from another Worker
--replace-mx             Allow replacing the domain's existing MX records (never implied by --yes)
```

Non-interactive example, for CI or scripts:

```bash
npm run setup -- --address support@acme.com --account-id <id> --yes
```

If the domain already has MX records elsewhere, this stops; add `--replace-mx` only if that is what you want.

## Several help desks on one account

Give each one its own `--worker` and `--profile`. The D1 database, R2 bucket and Workflow names are derived from the worker name, so they never collide:

```bash
npm run setup -- --address support@app-a.com --worker helpdesk-app-a --profile app-a
npm run setup -- --address help@app-b.com    --worker helpdesk-app-b --profile app-b
```

Alternatively, run **one** Worker for several projects by adding more mailboxes through the API, each with its own ref prefix. Add their addresses to the profile's `addresses` list and redeploy.

## Postgres, MySQL, PlanetScale

```bash
npm run setup -- --address support@acme.com --db postgres --database-url 'postgres://user:pass@host:5432/helpdesk'
```

- **Postgres and MySQL:** setup creates a Hyperdrive config from the URL, so the URL is never written to disk. It then applies migrations with `npm run db:migrate`, passing the URL through the environment. Finally it builds the Worker with only that driver. MySQL needs TLS. A database on your LAN needs a Cloudflare Tunnel; see docs/DATABASE.md.
  - Note that `wrangler hyperdrive create` only accepts the URL as a command-line argument. While that one command runs, the URL is visible in your machine's process list.
- **PlanetScale (Vitess):** setup stores the URL as the `DATABASE_URL` secret. Schema changes go through a deploy request; setup prints the steps.

## Day-2 commands

```bash
cd apps/worker
export CLOUDFLARE_ACCOUNT_ID=<id>
npx wrangler deploy -c wrangler.<profile>.jsonc                      # after pulling new code
npx wrangler d1 migrations apply DB --remote -c wrangler.<profile>.jsonc   # before deploying, when migrations change
npx wrangler tail -c wrangler.<profile>.jsonc                        # live logs
```

Set `CLOUDFLARE_ACCOUNT_ID` when your login has several accounts. Without it, wrangler can stop at an account prompt in non-interactive runs.

## Removing a deployment

```bash
cd apps/worker && export CLOUDFLARE_ACCOUNT_ID=<id>
npx wrangler delete -c wrangler.<profile>.jsonc
npx wrangler d1 delete <worker-name>
npx wrangler r2 bucket delete <worker-name>-mail    # the bucket must be empty first
```

Then:
- Remove the address's rule under Email → Email Routing → Routing rules in the dashboard.
- Delete `apps/worker/wrangler.<profile>.jsonc` and `apps/worker/.helpdesk/<profile>.env`.
