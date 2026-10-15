import { type ClassificationOutcome, formatRef, type Mailbox, type Ticket, type TicketPriority, type TicketStatus } from "@cf-helpdesk/core";
import { type InsertQueryBuilder, type InsertResult, Kysely, sql, type Transaction } from "kysely";
import { monotonicFactory } from "ulidx";

// Monotonic: ids created in the same millisecond still sort in creation order.
const ulid = monotonicFactory();
import { toD1Statement } from "./d1-dialect";
import type { Database, MessagesTable, TicketClassificationsTable, TicketEventsTable, TicketsTable } from "./schema";
import type { SqlDialect } from "./types";

export type NewMessage = Omit<MessagesTable, "id" | "ticket_id" | "mailbox_id" | "created_at">;

export interface NewAttachment {
  r2Key: string;
  filename: string | null;
  mimeType: string;
  size: number;
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
}

export interface TicketDetail {
  ticket: Ticket;
  requester: Contact | null;
  messages: MessagesTable[];
  events: TicketEventsTable[];
  classifications: TicketClassificationsTable[];
}

export interface SaveClassificationInput {
  ticket: Ticket;
  /** The inbound message that was classified. */
  messageId: string;
  outcome: ClassificationOutcome;
}

/** Storage port used by the Worker. One implementation per dialect family; see createRepo(). */
export interface HelpdeskRepo {
  readonly dialect: SqlDialect;
  getMailboxByAddress(address: string): Promise<Mailbox | null>;
  createMailbox(input: { address: string; name: string; refPrefix: string; fromName?: string | null }): Promise<Mailbox>;
  listMailboxAddresses(): Promise<string[]>;
  upsertContact(email: string, name: string | null): Promise<Contact>;
  getContact(id: string): Promise<Contact | null>;
  /** Already-ingested inbound message; `createdTicket` is true if that message opened the ticket. */
  findInboundByIngestKey(key: string): Promise<{ messageId: string; ticketId: string; createdTicket: boolean } | null>;
  findTicketByMessageIds(mailboxId: string, messageIds: string[]): Promise<Ticket | null>;
  findTicketByRef(ref: string): Promise<Ticket | null>;
  getTicket(id: string): Promise<Ticket | null>;
  getTicketDetail(ref: string): Promise<TicketDetail | null>;
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
  /**
   * Persist every classifier attempt, update the ticket's category/summary (and priority, if still the
   * default) and record a `ticket.classified` event, atomically. Idempotent per (ticket, message):
   * a retried Workflow step replaces the previous rows instead of duplicating them.
   */
  saveClassification(input: SaveClassificationInput): Promise<void>;
  listTickets(filter: { status?: string; mailboxId?: string; limit: number; cursor?: string }): Promise<Ticket[]>;
  /** Release connections (no-op for D1). Call when the request/step is done. */
  close(): Promise<void>;
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
    category: r.category ?? null,
    categoryConfidence: r.category_confidence == null ? null : Number(r.category_confidence) / 1000,
    codeRelated: r.code_related == null ? null : Number(r.code_related) === 1,
    summary: r.summary ?? null,
  };
}

const milli = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1000);

/** Normalise driver differences (pg/PlanetScale return BIGINT as string) for rows we hand out. */
function normaliseRow<T extends { created_at: number }>(r: T): T {
  return { ...r, created_at: Number(r.created_at) };
}

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Kysely implementation for transactional databases (Postgres, MySQL, PlanetScale).
 * D1 has no interactive transactions, so D1Repo overrides the two multi-statement writes with batches.
 */
export class SqlRepo implements HelpdeskRepo {
  constructor(
    readonly db: Kysely<Database>,
    readonly dialect: SqlDialect,
    private readonly onClose: () => Promise<void> = () => db.destroy(),
  ) {}

  /** `INSERT ... do nothing on duplicate key`, per dialect. */
  protected insertIgnore<T extends keyof Database & string>(
    q: InsertQueryBuilder<Database, T, InsertResult>,
    conflictColumn: keyof Database[T] & string,
  ) {
    return this.dialect === "mysql"
      ? // No-op update instead of INSERT IGNORE, which would also swallow unrelated errors.
        q.onDuplicateKeyUpdate({ [conflictColumn]: sql.ref(conflictColumn) } as never)
      : q.onConflict((oc) => oc.column(conflictColumn as never).doNothing());
  }

  async close() {
    await this.onClose();
  }

  async getMailboxByAddress(address: string): Promise<Mailbox | null> {
    const r = await this.db.selectFrom("mailboxes").selectAll().where("address", "=", address.toLowerCase()).executeTakeFirst();
    return r ? { id: r.id, address: r.address, name: r.name, refPrefix: r.ref_prefix, fromName: r.from_name } : null;
  }

  async createMailbox(input: { address: string; name: string; refPrefix: string; fromName?: string | null }) {
    const address = input.address.toLowerCase();
    await this.insertIgnore(
      this.db.insertInto("mailboxes").values({
        id: ulid(),
        address,
        name: input.name,
        ref_prefix: input.refPrefix.toUpperCase(),
        from_name: input.fromName ?? null,
        settings_json: null,
        created_at: now(),
      }),
      "address",
    ).execute();
    return (await this.getMailboxByAddress(address))!;
  }

  async listMailboxAddresses(): Promise<string[]> {
    return (await this.db.selectFrom("mailboxes").select("address").execute()).map((r) => r.address);
  }

  async upsertContact(email: string, name: string | null) {
    const e = email.toLowerCase();
    await this.insertIgnore(this.db.insertInto("contacts").values({ id: ulid(), email: e, name, created_at: now() }), "email").execute();
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
    const ids = messageIds.slice(0, 50);
    const rows = await this.db
      .selectFrom("messages")
      .innerJoin("tickets", "tickets.id", "messages.ticket_id")
      .selectAll("tickets")
      .select(["messages.message_id_hdr as matched", "messages.provider_msg_id as matched_provider"])
      .where("messages.mailbox_id", "=", mailboxId)
      .where((eb) =>
        eb.or([
          eb("messages.message_id_hdr", "in", ids),
          // Email Sending assigns its own Message-ID; customer replies reference that one.
          eb("messages.provider_msg_id", "in", ids),
        ]),
      )
      .execute();
    // Callers pass ids parent-first; prefer the most specific match.
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

  async getTicketDetail(ref: string): Promise<TicketDetail | null> {
    const ticket = await this.findTicketByRef(ref);
    if (!ticket) return null;
    const [messages, events, classifications, requester] = await Promise.all([
      this.db.selectFrom("messages").selectAll().where("ticket_id", "=", ticket.id).orderBy("created_at").orderBy("id").execute(),
      this.db.selectFrom("ticket_events").selectAll().where("ticket_id", "=", ticket.id).orderBy("created_at").orderBy("id").execute(),
      this.db.selectFrom("ticket_classifications").selectAll().where("ticket_id", "=", ticket.id).orderBy("created_at").orderBy("id").execute(),
      this.getContact(ticket.requesterId),
    ]);
    return {
      ticket,
      requester,
      messages: messages.map(normaliseRow),
      events: events.map(normaliseRow),
      classifications: classifications.map(normaliseRow),
    };
  }

  /**
   * Allocate the next per-mailbox number and insert ticket + first message + attachments + event
   * atomically. The counter row is locked by the UPDATE until commit (Postgres and InnoDB), so the
   * following SELECT reads our own increment and concurrent creators serialise on that row.
   */
  async createTicketWithFirstMessage(input: Parameters<HelpdeskRepo["createTicketWithFirstMessage"]>[0]) {
    const ticketId = ulid();
    const messageId = ulid();
    const t = now();
    const scope = `ticket:${input.mailbox.id}`;
    await this.db.transaction().execute(async (tx) => {
      await this.insertIgnore(tx.insertInto("counters").values({ scope, value: 0 }), "scope").execute();
      await tx.updateTable("counters").set({ value: sql`value + 1` }).where("scope", "=", scope).execute();
      const { value } = await tx.selectFrom("counters").select("value").where("scope", "=", scope).executeTakeFirstOrThrow();
      const number = Number(value);
      await tx.insertInto("tickets").values(this.ticketRow(input, ticketId, number, formatRef(input.mailbox.refPrefix, number), t)).execute();
      await this.insertMessageRows(tx, input.mailbox.id, ticketId, messageId, input.message, input.attachments, t);
      await tx.insertInto("ticket_events").values(this.eventRow(ticketId, "ticket.created", "system:email", null, t)).execute();
    });
    return { ticket: (await this.getTicket(ticketId))!, messageId };
  }

  async appendMessage(input: Parameters<HelpdeskRepo["appendMessage"]>[0]) {
    const messageId = ulid();
    const t = now();
    const reopen = this.shouldReopen(input);
    await this.db.transaction().execute(async (tx) => {
      await this.insertMessageRows(tx, input.ticket.mailboxId, input.ticket.id, messageId, input.message, input.attachments, t);
      await tx.updateTable("tickets").set(this.ticketTouch(reopen, t)).where("id", "=", input.ticket.id).execute();
      await tx.insertInto("ticket_events").values(this.appendEventRow(input, messageId, reopen, t)).execute();
    });
    return { messageId };
  }

  async addEvent(ticketId: string, type: string, actor: string, data?: unknown) {
    await this.db.insertInto("ticket_events").values(this.eventRow(ticketId, type, actor, data, now())).execute();
  }

  async saveClassification(input: SaveClassificationInput) {
    await this.db.transaction().execute(async (tx) => {
      for (const q of this.classificationWrites(tx, input)) await q.execute();
    });
  }

  async listTickets(filter: { status?: string; mailboxId?: string; limit: number; cursor?: string }) {
    let q = this.db.selectFrom("tickets").selectAll().orderBy("id", "desc").limit(Math.max(1, Math.min(filter.limit || 25, 100)));
    if (filter.status) q = q.where("status", "=", filter.status);
    if (filter.mailboxId) q = q.where("mailbox_id", "=", filter.mailboxId);
    if (filter.cursor) q = q.where("id", "<", filter.cursor);
    return (await q.execute()).map(toTicket);
  }

  // ---- row builders shared with D1Repo -------------------------------------------------------

  /** The ordered writes for saveClassification; run in a transaction (SQL) or a batch (D1). */
  protected classificationWrites(db: Db, { ticket, messageId, outcome }: SaveClassificationInput) {
    const t = now();
    const actor = `system:classify:${messageId}`;
    const rows = outcome.attempts.map((a) => ({
      id: ulid(),
      ticket_id: ticket.id,
      message_id: messageId,
      classifier: a.classifier,
      provider: a.meta?.provider ?? null,
      model: a.meta?.model ?? null,
      category: a.result?.category ?? null,
      confidence: a.result ? milli(a.result.confidence) : null,
      code_related: a.result ? (a.result.codeRelated ? 1 : 0) : null,
      accepted: outcome.acceptedBy === a.classifier ? 1 : 0,
      result_json: a.result ? JSON.stringify(a.result) : null,
      error_text: a.error ? a.error.slice(0, 2000) : null,
      log_id: a.meta?.logId ?? null,
      duration_ms: Math.round(a.durationMs),
      created_at: t,
    }));
    const touch: Record<string, unknown> = {
      category: outcome.category,
      category_confidence: milli(outcome.confidence),
      code_related: outcome.codeRelated ? 1 : 0,
      summary: outcome.summary ?? null,
      updated_at: t,
    };
    // Only raise priority from the default; never override a human's choice.
    if (outcome.priority && ticket.priority === "normal") touch.priority = outcome.priority;
    return [
      db.deleteFrom("ticket_classifications").where("ticket_id", "=", ticket.id).where("message_id", "=", messageId),
      db.deleteFrom("ticket_events").where("ticket_id", "=", ticket.id).where("type", "=", "ticket.classified").where("actor", "=", actor),
      ...(rows.length ? [db.insertInto("ticket_classifications").values(rows)] : []),
      db.updateTable("tickets").set(touch).where("id", "=", ticket.id),
      db.insertInto("ticket_events").values(
        this.eventRow(ticket.id, "ticket.classified", actor, {
          category: outcome.category,
          confidence: outcome.confidence,
          acceptedBy: outcome.acceptedBy,
          codeRelated: outcome.codeRelated,
        }, t),
      ),
    ];
  }

  protected ticketRow(
    input: Parameters<HelpdeskRepo["createTicketWithFirstMessage"]>[0],
    id: string,
    number: number | ReturnType<typeof sql<number>>,
    ref: string | ReturnType<typeof sql<string>>,
    t: number,
  ) {
    return {
      id,
      mailbox_id: input.mailbox.id,
      number,
      ref,
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
      category: null,
      category_confidence: null,
      code_related: null,
      summary: null,
    };
  }

  protected eventRow(ticketId: string, type: string, actor: string, data: unknown, t: number) {
    return { id: ulid(), ticket_id: ticketId, type, actor, data_json: data == null ? null : JSON.stringify(data), created_at: t };
  }

  protected appendEventRow(input: Parameters<HelpdeskRepo["appendMessage"]>[0], messageId: string, reopened: boolean, t: number) {
    return this.eventRow(input.ticket.id, `message.${input.message.direction}`, input.actor, { messageId, kind: input.message.kind, reopened }, t);
  }

  protected shouldReopen(input: Parameters<HelpdeskRepo["appendMessage"]>[0]) {
    return input.reopen && (input.ticket.status === "solved" || input.ticket.status === "closed");
  }

  protected ticketTouch(reopen: boolean, t: number) {
    return reopen ? { updated_at: t, status: "open", closed_at: null } : { updated_at: t };
  }

  protected messageRow(mailboxId: string, ticketId: string, id: string, m: NewMessage, t: number) {
    return { ...m, id, ticket_id: ticketId, mailbox_id: mailboxId, created_at: t };
  }

  protected attachmentRows(messageId: string, attachments: NewAttachment[], t: number) {
    return attachments.map((a) => ({
      id: ulid(),
      message_id: messageId,
      r2_key: a.r2Key,
      filename: a.filename,
      mime_type: a.mimeType,
      size: a.size,
      created_at: t,
    }));
  }

  private async insertMessageRows(tx: Db, mailboxId: string, ticketId: string, messageId: string, m: NewMessage, atts: NewAttachment[], t: number) {
    await tx.insertInto("messages").values(this.messageRow(mailboxId, ticketId, messageId, m, t)).execute();
    const rows = this.attachmentRows(messageId, atts, t);
    if (rows.length) await tx.insertInto("attachments").values(rows).execute();
  }
}

/**
 * D1: same queries, but multi-statement writes go through D1Database.batch() (atomic, no
 * interactive transactions). The ticket number is read via subquery inside the batch because
 * RETURNING output cannot feed the next statement.
 */
export class D1Repo extends SqlRepo {
  constructor(private readonly d1: D1Database, db: Kysely<Database>) {
    super(db, "sqlite", async () => {});
  }

  private async batch(queries: { compile(): import("kysely").CompiledQuery }[]) {
    await this.d1.batch(queries.map((q) => toD1Statement(this.d1, q.compile())));
  }

  override async createTicketWithFirstMessage(input: Parameters<HelpdeskRepo["createTicketWithFirstMessage"]>[0]) {
    const ticketId = ulid();
    const messageId = ulid();
    const t = now();
    const scope = `ticket:${input.mailbox.id}`;
    const counterValue = sql<number>`(SELECT value FROM counters WHERE scope = ${scope})`;
    const ref = sql<string>`${input.mailbox.refPrefix} || '-' || printf('%06d', ${counterValue})`;
    const atts = this.attachmentRows(messageId, input.attachments, t);
    await this.batch([
      this.insertIgnore(this.db.insertInto("counters").values({ scope, value: 0 }), "scope"),
      this.db.updateTable("counters").set({ value: sql`value + 1` }).where("scope", "=", scope),
      this.db.insertInto("tickets").values(this.ticketRow(input, ticketId, counterValue, ref, t)),
      this.db.insertInto("messages").values(this.messageRow(input.mailbox.id, ticketId, messageId, input.message, t)),
      ...(atts.length ? [this.db.insertInto("attachments").values(atts)] : []),
      this.db.insertInto("ticket_events").values(this.eventRow(ticketId, "ticket.created", "system:email", null, t)),
    ]);
    const ticket = (await this.getTicket(ticketId))!;
    if (ticket.ref !== formatRef(input.mailbox.refPrefix, ticket.number)) {
      throw new Error(`ref format mismatch: SQL produced ${ticket.ref}, app expects ${formatRef(input.mailbox.refPrefix, ticket.number)}`);
    }
    return { ticket, messageId };
  }

  override async saveClassification(input: SaveClassificationInput) {
    await this.batch(this.classificationWrites(this.db, input));
  }

  override async appendMessage(input: Parameters<HelpdeskRepo["appendMessage"]>[0]) {
    const messageId = ulid();
    const t = now();
    const reopen = this.shouldReopen(input);
    const atts = this.attachmentRows(messageId, input.attachments, t);
    await this.batch([
      this.db.insertInto("messages").values(this.messageRow(input.ticket.mailboxId, input.ticket.id, messageId, input.message, t)),
      ...(atts.length ? [this.db.insertInto("attachments").values(atts)] : []),
      this.db.updateTable("tickets").set(this.ticketTouch(reopen, t)).where("id", "=", input.ticket.id),
      this.db.insertInto("ticket_events").values(this.appendEventRow(input, messageId, reopen, t)),
    ]);
    return { messageId };
  }
}

