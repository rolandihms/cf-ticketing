# Day-1 spikes

Spikes are the platform unknowns from the Fable review (docs/PLAN.md §8). They had to be settled before we built further.

| # | Question | Status | Result |
|---|---|---|---|
| 2 | Can Workflows be tested in the Workers Vitest integration? | ✅ Done (2026-10-14) | Yes. `@cloudflare/vitest-pool-workers` has been **renamed to `@cloudflare/vitest-plugin`** (v1.4.2), which ships `introspectWorkflow()` / `introspectWorkflowInstance()` with `waitForStatus`, `getOutput`, `mockStepResult`, `mockEvent` and `disableSleeps`. All 8 integration tests drive the real `email()` handler, which drives the real Workflow, which writes to D1. Storage is **not** reset between tests, so the tests clear tables in `beforeEach`. |
| — | Does local e2e work via `wrangler dev`? | ✅ Done | `POST /cdn-cgi/local/email?from=&to=` with a raw RFC 5322 body returns "Worker successfully processed email". The ticket was created, and the ack was written to `.wrangler/tmp/email/**.eml` with `In-Reply-To`, `References`, `Auto-Submitted` and `X-Helpdesk-Ticket` intact. A customer reply threaded back onto the same ticket. |
| — | Does the send binding keep our `Message-ID`? | ⚠️ Finding | **Locally it does not.** Miniflare replaced our `Message-ID` with its own and returned that id as `messageId`. The real service may do the same, so outbound rows now store both `message_id_hdr` (ours) and `provider_msg_id` (theirs), and threading matches either. |
| 1 | Does Email Sending keep `In-Reply-To` / `References` / `Auto-Submitted` / `X-Helpdesk-Ticket`? (raw MIME vs builder) | ⏳ Needs your account | See the procedure below. |
| 3 | Does `env.EMAIL.send()` work from inside a Workflow step in production? | ⏳ Needs your account | Covered by the same procedure: the ack is sent from the `ack:send` step. |

## Procedure for spikes 1 and 3 (about 15 minutes, on a real domain)

Prerequisites:
- a domain on Cloudflare DNS, with no other MX provider on the address you use
- Workers Paid, so Email Sending can reach arbitrary recipients; on Free, add your test inbox as a verified destination address

```bash
cd apps/worker
npx wrangler login
npx wrangler email routing enable example.com
npx wrangler email sending enable example.com
npx wrangler d1 create cf-helpdesk          # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create cf-helpdesk-mail
# wrangler.jsonc: set "addresses": ["support@example.com"]
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put API_TOKEN
npx wrangler deploy                          # also creates the Email Routing rule
curl -X POST https://cf-helpdesk.<subdomain>.workers.dev/api/mailboxes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"address":"support@example.com","name":"Example Support","refPrefix":"EX"}'
```

Then:
1. From Gmail, send an email to `support@example.com`. The ack (`[EX-000001] Re: …`) should arrive within seconds.
2. In Gmail, open **Show original** and record whether `Message-ID`, `In-Reply-To`, `References`, `Auto-Submitted` and `X-Helpdesk-Ticket` are present and unchanged.
3. Reply to the ack. `GET /api/tickets/EX-000001` should show three messages on one ticket.
4. Set `EMAIL_SEND_FORMAT` to `"builder"`, redeploy, and repeat steps 1–3.
5. Run `npx wrangler tail` during the test to see the Workflow and plugin logs.

Decision rule:
- Keep `raw` as the default if it preserves the headers.
- Otherwise use `builder`, provided it preserves the headers.
- If neither preserves the threading headers, threading relies on the `provider_msg_id` match plus the subject ref, which is already implemented.
