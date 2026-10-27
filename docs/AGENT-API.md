# Agent API

This is the REST API that agents (and later the web UI) use to work tickets. Base URL: your Worker, e.g. `https://cf-helpdesk.<you>.workers.dev`.

## Authentication

There are three ways in.

| Who | How | Role |
|---|---|---|
| **A host app** (embedding) | Over a service binding, with `X-Helpdesk-Service-Key` and `X-Helpdesk-Principal` (JSON: `externalId`, `email`, `name`, `role`, `partition`). Off unless `TRUSTED_PRINCIPAL=on`. The agent is created and re-synced from the identity on every request. See [EMBEDDING.md](EMBEDDING.md). | The given role, limited to the given partition |
| **People** | **Cloudflare Access** in front of the Worker. Access adds the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie). The Worker **verifies the JWT itself** (RS256 against your team's certs, plus audience, issuer and expiry). The verified email must belong to an **active agent**. | The agent's role (`admin` or `agent`) |
| **Automation** | `Authorization: Bearer <API_TOKEN>`. The token is the Worker secret created by `npm run setup` and saved in `apps/worker/.helpdesk/<profile>.env`. | `admin` (service) |

### Setting up Access for agents

1. Go to Zero Trust → Access → Applications → **Add a self-hosted application** for your Worker's hostname. Add a policy, e.g. emails ending in `@acme.com`.
2. Copy the application's **AUD tag**.
3. Set the vars and redeploy:
   ```jsonc
   "vars": { "ACCESS_TEAM_DOMAIN": "acme", "ACCESS_AUD": "<aud tag>" }   // team: acme.cloudflareaccess.com
   ```
4. Create the agents. The first admin is created with the API token:
   ```bash
   curl -X POST $URL/api/agents -H "authorization: Bearer $API_TOKEN" \
     -H 'content-type: application/json' -d '{"email":"you@acme.com","name":"You","role":"admin"}'
   ```

Access decides **who may reach** the Worker. The agents table decides **who may act**: an Access-approved person without an active agent record gets `403`.

**Permission model:**
- Every active agent can see and work every ticket **in its partition**. Callers without a partition (the API token, global agents, a trusted principal with `partition: null`) see everything. Outside your partition, everything answers `404`. See [EMBEDDING.md](EMBEDDING.md#4-partitions-multi-tenancy).
- `admin` additionally manages agents and mailboxes. A partition-restricted admin manages only its own partition's agents, and can't add mailboxes (a mailbox decides which partition an address's mail lands in).
- The help desk always keeps at least one active admin; the last one can't be demoted or deactivated.

**Browser safety:**
- Request bodies must be `application/json`; anything else gets `415`. This blocks HTML-form CSRF.
- For Access (cookie) logins, state-changing requests must be same-origin, checked with `Sec-Fetch-Site` / `Origin`.
- If Access's certificate endpoint is down, the API answers `503`; cached keys are used while they last.

## Endpoints

| Method & path | Who | What |
|---|---|---|
| `GET /api/me` | any | The authenticated principal |
| `GET /api/agents` | any | List agents |
| `POST /api/agents` `{email, name, role?, partition?}` | admin | Create an agent. Idempotent by email. Restricted admins always create in their own partition. |
| `PATCH /api/agents/:id` `{name?, role?, active?, partition?}` | admin | Update or deactivate an agent. You can't demote or deactivate yourself. Only unrestricted admins change `partition`. |
| `GET /api/mailboxes` | any | List mailboxes (your partition's) |
| `POST /api/mailboxes` `{address, name, refPrefix, fromName?, partition?}` | unrestricted admin | Add a mailbox (a plain `local@domain.tld` address, stored lowercase). Its tickets inherit `partition`. |
| `GET /api/tickets` | any | List tickets, newest first. Filters: `status=open,pending`, `assignee=me\|unassigned\|<agentId>`, `category=bug`, `mailbox=<id>`, `q=<text in subject or ref>`, `partition=<key>` (unrestricted callers only), `limit` (1–100), `cursor` (from `nextCursor`). `nextCursor: null` means you've reached the end; the last page can be empty. |
| `GET /api/tickets/:ref` | any | The ticket with requester, messages, attachments, events and classifications. Inbound messages carry `sender_verified`: `false` means DMARC didn't prove the From address, so it may be forged |
| `PATCH /api/tickets/:ref` `{status?, priority?, assignee?}` | any | `assignee` is an agent id, `"me"`, or `null`. Each change is recorded as an event attributed to you. Updates are compare-and-set: if someone changed the same field meanwhile, you get `409`; reload and retry. |
| `POST /api/tickets/:ref/notes` `{text}` | any | An internal note. Never emailed. |
| `POST /api/tickets/:ref/replies` `{text, status?}` | any | **Emails the customer** (details below). |
| `GET /api/messages/:id/text` | any | The full text of a message, note or reply. Bodies live in R2. |
| `GET /api/attachments/:id` | any | Download an attachment. Always served as a download (`nosniff`, sandbox CSP). |

Statuses: `new`, `open`, `pending` (waiting on the customer), `on_hold`, `solved`, `closed`. Priorities: `low`, `normal`, `high`, `urgent`.

### Replies

`POST /api/tickets/ACME-000123/replies`

```json
{ "text": "Thanks! Could you send a screenshot?", "status": "pending" }
```

- Sent through Email Sending from the mailbox address. The display name is `"<Agent> (<Mailbox name>)"`.
- **Threaded** into the customer's conversation: `In-Reply-To` is their latest message, and `References` is the whole chain. Our own outbound messages are referenced by the Message-ID Cloudflare assigned, which is what the customer's mail client actually saw.
- The subject is `[ACME-000123] Re: <original subject>`.
- It goes to the ticket's **requester**. People who were CC'd are not copied yet.
- The ticket moves to `status`, which defaults to `pending`. **The customer's next email reopens it** to `open`; this also applies to `solved` and `closed`. `on_hold` is deliberately left alone.
- **Retries are safe** with `Idempotency-Key: <your-key>`. The reply is recorded *before* it is sent, so:
  - the same key returns the original reply (`200`) without sending again, even for concurrent requests;
  - a crash after sending can never cause a second email.
- If sending fails, the response is `502` and the reservation is removed, so nothing is recorded or changed and a retry is safe. Provider error details are logged, not returned.

## Live test (2026-10-24, ihms.dev)

1. An agent reply to `HELP-000001` via the API arrived in the customer's existing Gmail conversation. The ticket became `pending`.
2. The customer answered from Gmail. The answer threaded onto `HELP-000001`, and the status went back to `open`.
3. The event log shows `ticket.status_changed` attributed to the agent, then `message.inbound` with `reopened: true`.
4. Hardening checks after the review:
   - Repeating a reply with the same `Idempotency-Key` returned `201`, then `200`, with exactly one email sent.
   - A `text/plain` POST was rejected with `415`.

### Events

Agent actions raise `ticket.status_changed`, `ticket.priority_changed`, `ticket.assigned`, `ticket.replied` and `ticket.note_added` for plugins' `onEvent` (for example signed webhooks).
- Delivery runs in the Workflow, so it is durable and retried.
- If events can't be queued, the action still succeeds; the change is recorded on the ticket either way.

## Not yet

- Attachments on replies, canned responses, and SLA timers.
- The web UI. This API is its backend.
