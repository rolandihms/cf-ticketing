import type { HelpdeskEnv } from "./env";
import { computeIngestKey, evaluateInbound, firstHeader, type Mailbox } from "@rolandihms/helpdesk-core";
import { EmailMessage } from "cloudflare:email";
import { createRepo, type HelpdeskRepo } from "@rolandihms/helpdesk-db";
import { newMessageId, toRawMime } from "./email/outbound";
import { parseAndStore, r2Prefix } from "./email/parse";
import { ackTemplate } from "./email/templates";
import { ingestInbound } from "./ingest";
import type { HelpdeskOptions } from "./options";
import type { InboundParams } from "./workflow";

const MAX_RAW_BYTES = 25 * 1024 * 1024;

/** Body bytes after the header block, used for the ingest key when Message-ID is missing. */
function bodyBytes(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  for (let i = 0; i < raw.length - 3; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) return raw.subarray(i + 4);
  }
  return raw;
}

async function resolveMailbox(repo: HelpdeskRepo, env: HelpdeskEnv, address: string): Promise<Mailbox | null> {
  const found = await repo.getMailboxByAddress(address);
  if (found || env.AUTO_CREATE_MAILBOXES !== "true") return found;
  return repo.createMailbox({ address, name: address.split("@")[0]!, refPrefix: env.DEFAULT_REF_PREFIX || "TKT" });
}

/**
 * Email Routing entry point. Kept small: guard, store raw in R2, start the Workflow.
 * Everything is awaited (never waitUntil): if this throws, the sending MTA should retry later,
 * and every step downstream is idempotent so redelivery is safe.
 */
export async function handleEmail(message: ForwardableEmailMessage, env: HelpdeskEnv, config: Pick<HelpdeskOptions, "requireDmarc" | "trustedAuthServIds"> = {}): Promise<void> {
  const repo = await createRepo(env);
  try {
    await handle(message, env, repo, config);
  } finally {
    await repo.close();
  }
}

async function handle(message: ForwardableEmailMessage, env: HelpdeskEnv, repo: HelpdeskRepo, config: Pick<HelpdeskOptions, "requireDmarc" | "trustedAuthServIds">): Promise<void> {
  const to = message.to.toLowerCase();

  const mailbox = await resolveMailbox(repo, env, to);
  if (!mailbox) {
    message.setReject("Unknown recipient");
    return;
  }
  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject("Message too large");
    return;
  }

  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const guard = evaluateInbound({
    envelopeFrom: message.from,
    headers: message.headers,
    ownAddresses: await repo.listMailboxAddresses(),
    // From the raw message, not message.headers: get() joins every copy, and only the topmost is our MTA's.
    authenticationResults: firstHeader(raw, "authentication-results"),
    trustedAuthServIds: config.trustedAuthServIds,
    requireDmarc: config.requireDmarc,
  });
  if (!guard.accept) {
    console.log(JSON.stringify({ msg: "inbound dropped", from: message.from, to, reasons: guard.reasons }));
    return;
  }

  const ingestKey = await computeIngestKey({
    mailbox: to,
    messageId: message.headers.get("message-id"),
    from: message.from,
    date: message.headers.get("date"),
    subject: message.headers.get("subject"),
    body: bodyBytes(raw),
  });
  const rawKey = `${r2Prefix(mailbox.id, ingestKey)}/raw.eml`;
  await env.MAIL.put(rawKey, raw, { customMetadata: { from: message.from, to } });

  const ref = { ingestKey, mailboxId: mailbox.id, mailboxAddress: to, envelopeFrom: message.from, rawKey };
  let ack: InboundParams["ack"] = env.ACK_MODE === "send" ? "workflow" : "none";

  if (env.ACK_MODE === "reply" && guard.allowAutoReply) {
    // Free-plan path: message.reply() only works here, in the handler. Same idempotent ingest as the Workflow.
    try {
      const meta = await parseAndStore(env.MAIL, ref);
      const r = await ingestInbound(repo, mailbox, meta, guard);
      if (r.created) {
        const tpl = ackTemplate(mailbox, r.ticket, meta);
        const messageId = newMessageId(to.split("@")[1]!);
        const mime = toRawMime({
          from: { email: to, name: mailbox.fromName ?? mailbox.name },
          to: { email: meta.from.address, name: meta.from.name },
          subject: tpl.subject,
          text: tpl.text,
          html: tpl.html,
          messageId,
          inReplyTo: meta.messageId,
          references: meta.references.slice().reverse(),
          ticketRef: r.ticket.ref,
          autoSubmitted: true,
        });
        await message.reply(new EmailMessage(to, message.from, mime));
        await repo.appendMessage({
          ticket: r.ticket,
          reopen: false,
          actor: "system:ack",
          attachments: [],
          message: {
            direction: "outbound", kind: "ack", ingest_key: null, message_id_hdr: messageId, provider_msg_id: null,
            in_reply_to: meta.messageId, from_addr: to, to_json: JSON.stringify([meta.from.address]), cc_json: null,
            subject: tpl.subject, text_preview: tpl.text.slice(0, 500), text_r2_key: null, html_r2_key: null,
            raw_r2_key: null, auth_json: null, author_agent_id: null,
          },
        });
        ack = "handled";
      }
    } catch (err) {
      // reply() throws for non-DMARC-passing senders; the Workflow still records the ticket.
      console.warn(JSON.stringify({ msg: "reply-mode ack failed", error: String(err) }));
    }
  }

  const params: InboundParams = { ...ref, guard, ack };
  try {
    await env.INBOUND_WORKFLOW.create({ id: ingestKey, params });
  } catch (err) {
    // Duplicate instance id = redelivery of a message we already accepted. Anything else: rethrow so the MTA retries.
    const exists =
      String(err).includes("already_exists") || (await env.INBOUND_WORKFLOW.get(ingestKey).then(() => true, () => false));
    if (!exists) throw err;
    console.log(JSON.stringify({ msg: "duplicate delivery ignored", ingestKey }));
  }
}
