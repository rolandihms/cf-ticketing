// The requester side of the API (docs/EMBEDDING.md §7): customers of the host app raise tickets, read the
// public side of the tickets they may see, and reply. They never see notes, events, classifications, the
// assignee, or anyone's email address.
import { sha256Hex, TICKET_STATUSES, type Ticket, type TicketStatus } from "@rolandihms/helpdesk-core";
import { type HelpdeskRepo, type MessagesTable, type TicketFilter, withRepo } from "@rolandihms/helpdesk-db";
import type { RequesterPrincipal, StaffPrincipal } from "./auth";
import { body, type C, headerText, HttpError, idempotencyKey, metadataField, partitionField, preview, senderVerifiedOf, str } from "./http";
import { queuePortal } from "./workflow";

const ROUTES: [string, RegExp][] = [
  ["GET", /^\/api\/me$/],
  ["GET", /^\/api\/tickets$/],
  ["POST", /^\/api\/tickets$/],
  ["GET", /^\/api\/tickets\/[^/]+$/],
  ["POST", /^\/api\/tickets\/[^/]+\/messages$/],
  ["GET", /^\/api\/messages\/[^/]+\/text$/],
  ["GET", /^\/api\/attachments\/[^/]+$/],
];

/** The only routes a requester may call; everything else is 403 before any handler runs. */
export const allows = (method: string, path: string) => ROUTES.some(([m, re]) => m === method && re.test(path));

/** Can this requester see the ticket? Only verified requesters' tickets: theirs, or their company's. */
export function sees(p: RequesterPrincipal, t: Ticket): boolean {
  if (t.requesterVerified !== true) return false;
  if (t.requesterId === p.contact.id) return true;
  return p.visibility === "partition" && p.partition !== null && t.partition === p.partition;
}

const PUBLIC_KINDS = new Set(["customer", "ack", "agent_reply"]);

/** Messages a requester may see: customer messages whose sender is proven, acks and agent replies. */
export function isPublic(m: MessagesTable): boolean {
  if (!PUBLIC_KINDS.has(m.kind)) return false;
  if (m.direction === "inbound") return senderVerifiedOf(m) === true;
  return m.direction === "outbound";
}

// ---- views (names only, never addresses) ------------------------------------------------------

export interface RequesterTicketView {
  ref: string;
  subject: string;
  status: TicketStatus;
  source: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, string>;
  /** Who raised it; isYou when it's the caller. */
  requester: { name: string; isYou: boolean };
}

export interface RequesterMessageView {
  id: string;
  kind: "customer" | "ack" | "agent_reply";
  author: { name: string; staff: boolean; isYou: boolean };
  /** The first 500 characters; the full text is GET /api/messages/:id/text. */
  preview: string;
  createdAt: number;
  attachments: { id: string; filename: string | null; mimeType: string; size: number }[];
}

function ticketView(p: RequesterPrincipal, t: Ticket, names: Map<string, string>): RequesterTicketView {
  return {
    ref: t.ref,
    subject: t.subject,
    status: t.status,
    source: t.source,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    metadata: t.metadata,
    requester: { name: names.get(t.requesterId) ?? "Customer", isYou: t.requesterId === p.contact.id },
  };
}

async function messageViews(repo: HelpdeskRepo, p: RequesterPrincipal, ticket: Ticket, messages: MessagesTable[], attachments: { id: string; message_id: string; filename: string | null; mime_type: string; size: number }[]) {
  const visible = messages.filter(isPublic);
  const contactIds = visible.filter((m) => m.direction === "inbound").map((m) => m.author_contact_id ?? ticket.requesterId);
  const names = await repo.getContactNames(contactIds);
  const agentIds = [...new Set(visible.map((m) => m.author_agent_id).filter((x): x is string => !!x))];
  const agentNames = new Map((await Promise.all(agentIds.map((id) => repo.getAgent(id)))).filter((a) => !!a).map((a) => [a!.id, a!.name]));
  const mailbox = await repo.getMailbox(ticket.mailboxId);
  const team = mailbox?.fromName ?? mailbox?.name ?? "Support";
  return visible.map((m): RequesterMessageView => {
    const contactId = m.author_contact_id ?? ticket.requesterId;
    const inbound = m.direction === "inbound";
    return {
      id: m.id,
      kind: m.kind as RequesterMessageView["kind"],
      author: inbound
        ? { name: names.get(contactId) ?? "Customer", staff: false, isYou: contactId === p.contact.id }
        : { name: (m.author_agent_id && agentNames.get(m.author_agent_id)) || team, staff: true, isYou: false },
      preview: m.text_preview ?? "",
      createdAt: Number(m.created_at),
      attachments: attachments.filter((a) => a.message_id === m.id).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: Number(a.size) })),
    };
  });
}

// ---- handlers ---------------------------------------------------------------------------------

export async function listTickets(c: C, p: RequesterPrincipal) {
  const q = c.req.query();
  const n = Number(q.limit ?? 25);
  const filter: TicketFilter = {
    limit: Number.isFinite(n) ? Math.max(1, Math.min(Math.trunc(n), 100)) : 25,
    requester: { contactId: p.contact.id, partition: p.visibility === "partition" ? p.partition : null },
  };
  if (q.status) {
    const statuses = q.status.split(",");
    if (statuses.some((s) => !TICKET_STATUSES.includes(s as TicketStatus))) throw new HttpError(400, `status must be among ${TICKET_STATUSES.join(", ")}`);
    filter.statuses = statuses;
  }
  if (q.cursor) filter.cursor = q.cursor;
  const { tickets, names } = await withRepo(c.env, async (r) => {
    const tickets = await r.listTickets(filter);
    return { tickets, names: await r.getContactNames(tickets.map((t) => t.requesterId)) };
  });
  return c.json({ tickets: tickets.map((t) => ticketView(p, t, names)), nextCursor: tickets.length === filter.limit ? tickets.at(-1)!.id : null });
}

export async function getTicket(c: C, p: RequesterPrincipal, ref: string) {
  const out = await withRepo(c.env, async (r) => {
    const d = await r.getTicketDetail(ref);
    if (!d || !sees(p, d.ticket)) return null;
    const names = await r.getContactNames([d.ticket.requesterId]);
    return { ticket: ticketView(p, d.ticket, names), messages: await messageViews(r, p, d.ticket, d.messages, d.attachments) };
  });
  return out ? c.json(out) : c.json({ error: "ticket not found" }, 404);
}

/** The message, if this requester may read it (public, on a ticket it sees); else 404. */
export async function messageOr404(c: C, repo: HelpdeskRepo, p: RequesterPrincipal, id: string) {
  const msg = await repo.getMessage(id);
  const ticket = msg && (await repo.getTicket(msg.ticket_id));
  if (!msg || !ticket || !sees(p, ticket) || !isPublic(msg)) throw new HttpError(404, "message not found");
  return msg;
}

const SOURCES = ["portal", "app"];

/**
 * POST /api/tickets: a requester raises a ticket, or staff raise one on a customer's behalf (with `requester`).
 * It gets the next ref and goes through the same Workflow as mail: classification, staff notification, plugins.
 * No acknowledgement email unless `ack: true`. Send `Idempotency-Key`: a repeated key returns the first ticket.
 */
export async function createTicket(c: C, p: RequesterPrincipal | StaffPrincipal) {
  const b = await body<{
    mailbox: string; subject: string; text: string; partition: string | null; metadata: Record<string, string>;
    source: string; ack: boolean; requester: { email: string; name?: string; externalId?: string };
  }>(c);
  const mailboxRef = str(b.mailbox, "mailbox", 254).trim();
  const subject = headerText(b.subject, "subject");
  const text = str(b.text, "text", 50_000);
  const source = b.source ?? "portal";
  if (!SOURCES.includes(source)) throw new HttpError(400, `source must be one of ${SOURCES.join(", ")}`);
  if (b.ack !== undefined && typeof b.ack !== "boolean") throw new HttpError(400, "ack must be a boolean");
  const metadata = b.metadata === undefined ? undefined : metadataField(b.metadata);
  const asked = partitionField(b.partition);
  const idem = idempotencyKey(c);

  const out = await withRepo(c.env, async (r) => {
    const mailbox = (await r.getMailboxByAddress(mailboxRef)) ?? (await r.getMailbox(mailboxRef));
    // The ticket's partition: the requester's company, a restricted agent's own, or the admin's choice.
    let partition: string | null;
    if (p.kind === "requester") {
      if (asked !== undefined && asked !== p.partition) throw new HttpError(403, "a requester can only raise tickets in its own partition");
      partition = p.partition;
    } else if (p.partition !== null) {
      if (asked !== undefined && asked !== p.partition) throw new HttpError(403, "you can only raise tickets in your partition");
      partition = p.partition;
    } else partition = asked === undefined ? (mailbox?.partition ?? null) : asked;
    if (!mailbox || (mailbox.partition !== null && mailbox.partition !== partition)) throw new HttpError(404, "mailbox not found");

    let contact = p.kind === "requester" ? p.contact : null;
    if (!contact) {
      const q = b.requester;
      if (!q || typeof q !== "object") throw new HttpError(400, "requester {email, name?, externalId?} is required when staff raise a ticket");
      const email = str(q.email, "requester.email", 320).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "requester.email is invalid");
      const name = q.name === undefined || q.name === "" ? null : headerText(q.name, "requester.name");
      if (q.externalId !== undefined && (typeof q.externalId !== "string" || !/^[\x21-\x7e]{1,128}$/.test(q.externalId))) {
        throw new HttpError(400, "requester.externalId: 1-128 printable ASCII characters");
      }
      contact = q.externalId ? await r.upsertContactByExternalId({ externalId: q.externalId, email, name: name ?? email.split("@")[0]! }) : await r.upsertContact(email, name);
    }

    const sourceKey = idem ? await sha256Hex(`create:${p.actor}:${idem}`) : null;
    const replay = async () => {
      const t = sourceKey ? await r.findTicketBySourceKey(sourceKey) : null;
      return t ? { status: 200 as const, ticket: t } : null;
    };
    const earlier = await replay();
    if (earlier) return earlier;

    const textKey = `portal/${contact.id}/${crypto.randomUUID()}.txt`;
    await c.env.MAIL.put(textKey, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    try {
      const { ticket, messageId } = await r.createTicketWithFirstMessage({
        mailbox, requesterId: contact.id, subject, sourceIngestKey: sourceKey, attachments: [],
        source, partition, ...(metadata ? { metadata } : {}), requesterVerified: true, actor: p.actor,
        message: {
          direction: "inbound", kind: "customer", ingest_key: null, message_id_hdr: null, provider_msg_id: null, in_reply_to: null,
          from_addr: contact.email, to_json: JSON.stringify([mailbox.address]), cc_json: null, subject, text_preview: preview(text),
          text_r2_key: textKey, html_r2_key: null, raw_r2_key: null,
          auth_json: JSON.stringify({ source, via: p.via, senderVerified: true }),
          author_agent_id: null, author_contact_id: contact.id,
        },
      });
      return { status: 201 as const, ticket, messageId };
    } catch (err) {
      // Two requests with the same Idempotency-Key raced: the unique source key let one through.
      const raced = await replay();
      if (raced) return raced;
      throw err;
    }
  });

  if (out.status === 201) await queuePortal(c.env, { ticketId: out.ticket.id, messageId: out.messageId, created: true, ack: b.ack === true });
  if (p.kind !== "requester") return c.json(out.ticket, out.status);
  const names = await withRepo(c.env, (r) => r.getContactNames([out.ticket.requesterId]));
  return c.json(ticketView(p, out.ticket, names), out.status);
}

/**
 * POST /api/tickets/:ref/messages: a requester replies on a ticket it can see. Stored like a customer email
 * (reopens a pending/solved ticket), authored by the caller; no email goes out. Idempotent with Idempotency-Key.
 */
export async function postMessage(c: C, p: RequesterPrincipal, ref: string) {
  const b = await body<{ text: string }>(c);
  const text = str(b.text, "text", 50_000);
  const idem = idempotencyKey(c);
  const out = await withRepo(c.env, async (r) => {
    const ticket = await r.findTicketByRef(ref);
    if (!ticket || !sees(p, ticket)) throw new HttpError(404, "ticket not found");
    const ingestKey = idem ? await sha256Hex(`portal-msg:${ticket.id}:${p.contact.id}:${idem}`) : null;
    const replay = async () => {
      const m = ingestKey ? await r.findMessageByIngestKey(ingestKey) : null;
      return m ? { status: 200 as const, ticket, message: m } : null;
    };
    const earlier = await replay();
    if (earlier) return earlier;
    const textKey = `tickets/${ticket.id}/messages/${crypto.randomUUID()}.txt`;
    await c.env.MAIL.put(textKey, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    let messageId: string;
    try {
      ({ messageId } = await r.appendMessage({
        ticket, reopen: true, actor: p.actor, attachments: [],
        message: {
          direction: "inbound", kind: "customer", ingest_key: ingestKey, message_id_hdr: null, provider_msg_id: null, in_reply_to: null,
          from_addr: p.contact.email, to_json: "[]", cc_json: null, subject: ticket.subject, text_preview: preview(text),
          text_r2_key: textKey, html_r2_key: null, raw_r2_key: null,
          auth_json: JSON.stringify({ source: "portal", via: p.via, senderVerified: true }),
          author_agent_id: null, author_contact_id: p.contact.id,
        },
      }));
    } catch (err) {
      const raced = await replay();
      if (raced) return raced;
      throw err;
    }
    return { status: 201 as const, ticket: (await r.getTicket(ticket.id))!, message: (await r.getMessage(messageId))! };
  });
  if (out.status === 201) await queuePortal(c.env, { ticketId: out.ticket.id, messageId: out.message.id, created: false, ack: false });
  const view = await withRepo(c.env, async (r) => {
    const names = await r.getContactNames([out.ticket.requesterId]);
    const [message] = await messageViews(r, p, out.ticket, [out.message], []);
    return { message: message!, ticket: ticketView(p, out.ticket, names) };
  });
  return c.json(view, out.status);
}
