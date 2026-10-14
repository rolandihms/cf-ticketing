import { formatRef, type Mailbox, type Ticket, type TicketPriority, type TicketStatus } from "@cf-helpdesk/core";
import { Kysely, sql } from "kysely";
import { ulid } from "ulidx";
import { D1Dialect, toD1Statement } from "./d1-dialect";
import type { Database, MessagesTable, TicketsTable } from "./schema";

export type NewMessage = Omit<MessagesTable, "id" | "ticket_id" | "mailbox_id" | "created_at">;

export interface NewAttachment {
  r2Key: string;
  filename: string | null;
  mimeType: string;
  size: number;
}

/**
 * Storage port. Phase 1 ships the D1 implementation; Postgres/MySQL/PlanetScale implement the
 * same interface in Phase 2 (only ticket numbering differs materially between dialects).
 */
export interface HelpdeskRepo {
  getMailboxByAddress(address: string): Promise<Mailbox | null>;
  createMailbox(input: { address: string; name: string; refPrefix: string; fromName?: string | null }): Promise<Mailbox>;
  listMailboxAddresses(): Promise<string[]>;
  upsertContact(email: string, name: string | null): Promise<{ id: string; email: string; name: string | null }>;
  getContact(id: string): Promise<{ id: string; email: string; name: string | null } | null>;
  /** Already-ingested inbound message; `createdTicket` is true if that message opened the ticket. */
  findInboundByIngestKey(key: string): Promise<{ messageId: string; ticketId: string; createdTicket: boolean } | null>;
  findTicketByMessageIds(mailboxId: string, messageIds: string[]): Promise<Ticket | null>;
  findTicketByRef(ref: string): Promise<Ticket | null>;
  getTicket(id: string): Promise<Ticket | null>;
  createTicketWithFirstMessage(input: {
    mailbox: Mailbox;
    requesterId: string;
    subject: string;
    sourceIngestKey: string | null;
    message: NewMessage;
    attachments: NewAttachment[];
  }): Promise<{ ticket: Ticket; messageId: string }>;
  appendMessage(input: {
    ticket: Ticket;
    message: NewMessage;
    attachments: NewAttachment[];
    reopen: boolean;
    actor: string;
  }): Promise<{ messageId: string }>;
  addEvent(ticketId: string, type: string, actor: string, data?: unknown): Promise<void>;
  listTickets(filter: { status?: string; mailboxId?: string; limit: number; cursor?: string }): Promise<Ticket[]>;
}

const now = () => Date.now();

function toTicket(r: TicketsTable): Ticket {
  return {
    id: r.id,
    mailboxId: r.mailbox_id,
    number: Number(r.number),
    ref: r.ref,
    subject: r.subject,
    status: r.status as TicketStatus,
    priority: r.priority as TicketPriority,
    requesterId: r.requester_id,
    assigneeId: r.assignee_id,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class D1Repo implements HelpdeskRepo {
  readonly db: Kysely<Database>;

  constructor(private readonly d1: D1Database) {
    this.db = new Kysely<Database>({ dialect: new D1Dialect(d1) });
  }

  async getMailboxByAddress(address: string): Promise<Mailbox | null> {
    const r = await this.db
      .selectFrom("mailboxes")
      .selectAll()
      .where("address", "=", address.toLowerCase())
      .executeTakeFirst();
    return r ? { id: r.id, address: r.address, name: r.name, refPrefix: r.ref_prefix, fromName: r.from_name } : null;
  }

  async createMailbox(input: { address: string; name: string; refPrefix: string; fromName?: string | null }) {
    const address = input.address.toLowerCase();
    await this.db
      .insertInto("mailboxes")
      .values({
        id: ulid(),
        address,
        name: input.name,
        ref_prefix: input.refPrefix.toUpperCase(),
        from_name: input.fromName ?? null,
        settings_json: null,
        created_at: now(),
      })
      .onConflict((oc) => oc.column("address").doNothing())
      .execute();
    return (await this.getMailboxByAddress(address))!;
  }

  async listMailboxAddresses(): Promise<string[]> {
    const rows = await this.db.selectFrom("mailboxes").select("address").execute();
    return rows.map((r) => r.address);
  }

  async upsertContact(email: string, name: string | null) {
    const e = email.toLowerCase();
    await this.db
      .insertInto("contacts")
      .values({ id: ulid(), email: e, name, created_at: now() })
      .onConflict((oc) => oc.column("email").doNothing())
      .execute();
    return (await this.db.selectFrom("contacts").select(["id", "email", "name"]).where("email", "=", e).executeTakeFirst())!;
  }

  async getContact(id: string) {
    return (await this.db.selectFrom("contacts").select(["id", "email", "name"]).where("id", "=", id).executeTakeFirst()) ?? null;
  }

  async findInboundByIngestKey(key: string) {
    const r = await this.db
      .selectFrom("messages")
      .innerJoin("tickets", "tickets.id", "messages.ticket_id")
      .select(["messages.id", "messages.ticket_id", "tickets.source_ingest_key"])
      .where("messages.ingest_key", "=", key)
      .executeTakeFirst();
    return r ? { messageId: r.id, ticketId: r.ticket_id, createdTicket: r.source_ingest_key === key } : null;
  }

  async findTicketByMessageIds(mailboxId: string, messageIds: string[]): Promise<Ticket | null> {
    if (messageIds.length === 0) return null;
    // Prefer the most specific match: callers pass ids ordered parent-first.
    const rows = await this.db
      .selectFrom("messages")
      .innerJoin("tickets", "tickets.id", "messages.ticket_id")
      .selectAll("tickets")
      .select(["messages.message_id_hdr as matched", "messages.provider_msg_id as matched_provider"])
      .where("messages.mailbox_id", "=", mailboxId)
      .where((eb) =>
        eb.or([
          eb("messages.message_id_hdr", "in", messageIds.slice(0, 50)),
          // Email Sending may assign its own Message-ID; customer replies then reference that one.
          eb("messages.provider_msg_id", "in", messageIds.slice(0, 50)),
        ]),
      )
      .execute();
    for (const id of messageIds) {
      const hit = rows.find((r) => r.matched === id || r.matched_provider === id);
      if (hit) return toTicket(hit);
    }
    return null;
  }

  async findTicketByRef(ref: string) {
    const r = await this.db.selectFrom("tickets").selectAll().where("ref", "=", ref.toUpperCase()).executeTakeFirst();
    return r ? toTicket(r) : null;
  }

  async getTicket(id: string) {
    const r = await this.db.selectFrom("tickets").selectAll().where("id", "=", id).executeTakeFirst();
    return r ? toTicket(r) : null;
  }

  /**
   * Allocates the next per-mailbox number and inserts ticket + first message + attachments + event
   * in ONE D1 batch (atomic). The counter UPDATE and the ticket INSERT are separate statements; the
   * INSERT reads the counter via subquery because RETURNING output can't feed the next statement.
   */
  async createTicketWithFirstMessage(input: Parameters<HelpdeskRepo["createTicketWithFirstMessage"]>[0]) {
    const { mailbox } = input;
    const scope = `ticket:${mailbox.id}`;
    const ticketId = ulid();
    const messageId = ulid();
    const t = now();
    const counterValue = sql<number>`(SELECT value FROM counters WHERE scope = ${scope})`;

    const statements = [
      this.db
        .insertInto("counters")
        .values({ scope, value: 0 })
        .onConflict((oc) => oc.column("scope").doNothing())
        .compile(),
      this.db
        .updateTable("counters")
        .set({ value: sql`value + 1` })
        .where("scope", "=", scope)
        .compile(),
      this.db
        .insertInto("tickets")
        .values({
          id: ticketId,
          mailbox_id: mailbox.id,
          number: counterValue,
          ref: sql<string>`${mailbox.refPrefix} || '-' || printf('%06d', ${counterValue})`,
          subject: input.subject,
          status: "new",
          priority: "normal",
          requester_id: input.requesterId,
          assignee_id: null,
          source: "email",
          source_ingest_key: input.sourceIngestKey,
          tags_json: null,
          created_at: t,
          updated_at: t,
          closed_at: null,
        })
        .compile(),
      this.db
        .insertInto("messages")
        .values({ ...input.message, id: messageId, ticket_id: ticketId, mailbox_id: mailbox.id, created_at: t })
        .compile(),
      ...this.attachmentInserts(messageId, input.attachments, t),
      this.db
        .insertInto("ticket_events")
        .values({ id: ulid(), ticket_id: ticketId, type: "ticket.created", actor: "system:email", data_json: null, created_at: t })
        .compile(),
    ];

    await this.d1.batch(statements.map((q) => toD1Statement(this.d1, q)));
    const ticket = await this.getTicket(ticketId);
    if (!ticket) throw new Error("ticket insert did not persist");
    // Sanity check: ref formatting in SQL must match the app's formatter.
    if (ticket.ref !== formatRef(mailbox.refPrefix, ticket.number)) {
      console.warn("ref format mismatch", ticket.ref, formatRef(mailbox.refPrefix, ticket.number));
    }
    return { ticket, messageId };
  }

  async appendMessage(input: Parameters<HelpdeskRepo["appendMessage"]>[0]) {
    const { ticket } = input;
    const messageId = ulid();
    const t = now();
    const reopen = input.reopen && (ticket.status === "solved" || ticket.status === "closed");
    const statements = [
      this.db
        .insertInto("messages")
        .values({ ...input.message, id: messageId, ticket_id: ticket.id, mailbox_id: ticket.mailboxId, created_at: t })
        .compile(),
      ...this.attachmentInserts(messageId, input.attachments, t),
      this.db
        .updateTable("tickets")
        .set(reopen ? { updated_at: t, status: "open", closed_at: null } : { updated_at: t })
        .where("id", "=", ticket.id)
        .compile(),
      this.db
        .insertInto("ticket_events")
        .values({
          id: ulid(),
          ticket_id: ticket.id,
          type: `message.${input.message.direction}`,
          actor: input.actor,
          data_json: JSON.stringify({ messageId, kind: input.message.kind, reopened: reopen }),
          created_at: t,
        })
        .compile(),
    ];
    await this.d1.batch(statements.map((q) => toD1Statement(this.d1, q)));
    return { messageId };
  }

  async addEvent(ticketId: string, type: string, actor: string, data?: unknown) {
    await this.db
      .insertInto("ticket_events")
      .values({
        id: ulid(),
        ticket_id: ticketId,
        type,
        actor,
        data_json: data === undefined ? null : JSON.stringify(data),
        created_at: now(),
      })
      .execute();
  }

  async listTickets(filter: { status?: string; mailboxId?: string; limit: number; cursor?: string }) {
    let q = this.db.selectFrom("tickets").selectAll().orderBy("id", "desc").limit(Math.min(filter.limit, 100));
    if (filter.status) q = q.where("status", "=", filter.status);
    if (filter.mailboxId) q = q.where("mailbox_id", "=", filter.mailboxId);
    if (filter.cursor) q = q.where("id", "<", filter.cursor);
    return (await q.execute()).map(toTicket);
  }

  private attachmentInserts(messageId: string, attachments: NewAttachment[], t: number) {
    return attachments.map((a) =>
      this.db
        .insertInto("attachments")
        .values({ id: ulid(), message_id: messageId, r2_key: a.r2Key, filename: a.filename, mime_type: a.mimeType, size: a.size, created_at: t })
        .compile(),
    );
  }
}

export function createRepo(env: { DB: D1Database }): HelpdeskRepo {
  return new D1Repo(env.DB);
}
