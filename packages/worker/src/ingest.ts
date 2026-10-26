import type { GuardResult, InboundMessageMeta, Mailbox, Ticket } from "@rolandihms/helpdesk-core";
import { findRefsInSubject } from "@rolandihms/helpdesk-core";
import type { HelpdeskRepo, NewMessage } from "@rolandihms/helpdesk-db";

export interface IngestResult {
  ticket: Ticket;
  created: boolean;
  messageId: string;
  /** How the message was matched to an existing ticket. */
  threadedBy: "new" | "duplicate" | "message-id" | "subject-ref";
}

/**
 * Persist an inbound message: dedupe on ingest key, thread onto an existing ticket, or open a new one.
 * Idempotent: safe to call repeatedly for the same message (Workflow retries, MTA redelivery,
 * ACK_MODE=reply doing it in the handler and the Workflow doing it again).
 */
export async function ingestInbound(repo: HelpdeskRepo, mailbox: Mailbox, meta: InboundMessageMeta, guard: GuardResult): Promise<IngestResult> {
  const existing = await repo.findInboundByIngestKey(meta.ingestKey);
  if (existing) {
    const ticket = await repo.getTicket(existing.ticketId);
    if (!ticket) throw new Error(`ticket ${existing.ticketId} vanished`);
    return { ticket, created: existing.createdTicket, messageId: existing.messageId, threadedBy: "duplicate" };
  }

  const contact = await repo.upsertContact(meta.from.address, meta.from.name);
  const message: NewMessage = {
    direction: "inbound",
    kind: "customer",
    ingest_key: meta.ingestKey,
    message_id_hdr: meta.messageId,
    provider_msg_id: null,
    in_reply_to: meta.inReplyTo,
    from_addr: meta.from.address,
    to_json: JSON.stringify(meta.to),
    cc_json: meta.cc.length ? JSON.stringify(meta.cc) : null,
    subject: meta.subject,
    text_preview: meta.textPreview,
    text_r2_key: meta.textKey,
    html_r2_key: meta.htmlKey,
    raw_r2_key: meta.rawKey,
    auth_json: JSON.stringify({ guard: guard.reasons, envelopeFrom: meta.envelopeFrom, auth: "edge-accepted" }),
    author_agent_id: null,
  };
  const attachments = meta.attachments.map((a) => ({ r2Key: a.key, filename: a.filename, mimeType: a.mimeType, size: a.size }));

  // 1. Threading headers matched against Message-IDs we stored (inbound and our outbound acks/replies).
  let target = await repo.findTicketByMessageIds(mailbox.id, meta.references);
  let threadedBy: IngestResult["threadedBy"] = "message-id";

  // 2. Subject token, trusted only when the sender is the ticket's requester (refs are guessable).
  let relatedRef: string | null = null;
  if (!target) {
    for (const ref of findRefsInSubject(meta.subject, mailbox.refPrefix)) {
      const t = await repo.findTicketByRef(ref);
      if (!t || t.mailboxId !== mailbox.id) continue;
      if (t.requesterId === contact.id) {
        target = t;
        threadedBy = "subject-ref";
        break;
      }
      relatedRef = ref;
    }
  }

  if (target) {
    const { messageId } = await repo.appendMessage({ ticket: target, message, attachments, reopen: true, actor: `contact:${contact.id}` });
    const ticket = (await repo.getTicket(target.id))!;
    return { ticket, created: false, messageId, threadedBy };
  }

  const { ticket, messageId } = await repo.createTicketWithFirstMessage({
    mailbox,
    requesterId: contact.id,
    subject: meta.subject || "(no subject)",
    sourceIngestKey: meta.ingestKey,
    message,
    attachments,
  });
  if (relatedRef) await repo.addEvent(ticket.id, "possible_related", "system:email", { ref: relatedRef });
  return { ticket, created: true, messageId, threadedBy: "new" };
}
