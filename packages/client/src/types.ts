// Wire types of the agent API (docs/AGENT-API.md). Tickets, agents and mailboxes are camelCase;
// messages, events and other rows are returned as stored (snake_case).
// Declared here rather than imported so the client has no dependencies; test/types.test.ts checks
// that Ticket, Agent and Mailbox still equal @rolandihms/helpdesk-core's.

export type TicketStatus = "new" | "open" | "pending" | "on_hold" | "solved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type AgentRole = "admin" | "agent";

export interface Agent {
  id: string;
  email: string;
  name: string;
  role: AgentRole;
  active: boolean;
  createdAt: number;
  /** Restricts the agent to one partition (null = all). See docs/EMBEDDING.md. */
  partition: string | null;
  /** The host app's user id, for agents provisioned through a trusted principal. */
  externalId: string | null;
}

export interface Mailbox {
  id: string;
  address: string;
  name: string;
  refPrefix: string;
  fromName: string | null;
  /** Opaque tenant key chosen by the host app (e.g. "company:42"); copied to the mailbox's tickets. */
  partition: string | null;
  /** Staff addresses emailed when this mailbox opens a new ticket (empty: none). */
  notifyNewTicket: string[];
}

export interface Ticket {
  id: string;
  mailboxId: string;
  number: number;
  ref: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterId: string;
  assigneeId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Set by classification; null until classified. */
  category: string | null;
  /** 0..1 */
  categoryConfidence: number | null;
  codeRelated: boolean | null;
  summary: string | null;
  /** From the mailbox, or the requester's company, at creation. */
  partition: string | null;
  /** "email", "portal" or "app". */
  source: string;
  /** String pairs set by the host app (≤20 keys), e.g. { "realty.siteId": "42" }. */
  metadata: Record<string, string>;
  /**
   * Whether the requester is proven: portal/app tickets and email with dmarc=pass. Requesters only see
   * verified tickets. null for tickets from before 0.2.0.
   */
  requesterVerified: boolean | null;
}

export type Principal = StaffPrincipal | RequesterPrincipal;

export interface StaffPrincipal {
  kind: "service" | "agent";
  role: AgentRole;
  /** Recorded on ticket events, e.g. "agent:01H…" or "api". */
  actor: string;
  agent?: Agent;
  /** The only partition this caller may see, or null for every partition. */
  partition: string | null;
  via: "token" | "access" | "trusted";
}

/** A customer of the host app (docs/EMBEDDING.md §7). */
export interface RequesterPrincipal {
  kind: "requester";
  role: "requester";
  actor: string;
  contact: Contact;
  partition: string | null;
  visibility: "own" | "partition";
  via: "trusted";
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  /** The host app's user id, for contacts that are requesters there. */
  externalId: string | null;
}

export interface Message {
  id: string;
  ticket_id: string;
  mailbox_id: string;
  direction: "inbound" | "outbound" | "note";
  /** customer | ack | agent_reply | note */
  kind: string;
  message_id_hdr: string | null;
  provider_msg_id: string | null;
  in_reply_to: string | null;
  from_addr: string;
  /** JSON array of addresses. */
  to_json: string;
  cc_json: string | null;
  subject: string;
  /** First 500 characters; the full text is at messages.text(id). */
  text_preview: string | null;
  author_agent_id: string | null;
  /** The contact who posted a requester message through the host app. */
  author_contact_id: string | null;
  created_at: number;
  /**
   * Inbound mail only: true when DMARC proved the From address. false means the sender may be forged, so
   * check before acting on it. null for our own messages and mail stored before 0.1.1.
   */
  sender_verified: boolean | null;
}

export interface Attachment {
  id: string;
  message_id: string;
  filename: string | null;
  mime_type: string;
  size: number;
  created_at: number;
}

export interface TicketEvent {
  id: string;
  ticket_id: string;
  /** e.g. ticket.created, ticket.assigned, message.inbound, github.issue.created */
  type: string;
  /** e.g. "agent:01H…", "contact:01H…", "system:email", "plugin:github" */
  actor: string;
  data_json: string | null;
  created_at: number;
}

export interface Classification {
  id: string;
  ticket_id: string;
  message_id: string | null;
  classifier: string;
  provider: string | null;
  model: string | null;
  category: string | null;
  /** Thousandths (0–1000). */
  confidence: number | null;
  accepted: number;
  created_at: number;
}

export interface TicketDetail {
  ticket: Ticket;
  requester: Contact | null;
  messages: Message[];
  attachments: Attachment[];
  events: TicketEvent[];
  classifications: Classification[];
}

export interface TicketFilter {
  status?: TicketStatus | TicketStatus[];
  /** "me", "unassigned" or an agent id. */
  assignee?: string;
  category?: string;
  mailbox?: string;
  /** Text in the subject or ref. */
  q?: string;
  /** Unrestricted callers only. */
  partition?: string;
  limit?: number;
  cursor?: string;
}

export interface TicketPage {
  tickets: Ticket[];
  /** Pass as `cursor` for the next page; null at the end. */
  nextCursor: string | null;
}

export interface TicketPatch {
  status?: TicketStatus;
  priority?: TicketPriority;
  /** An agent id, "me", or null to unassign. */
  assignee?: string | null;
  /** Replaces the whole map (≤20 keys of [A-Za-z0-9_.:-], values ≤200 chars). */
  metadata?: Record<string, string>;
  /** Unrestricted admins only: move the ticket to another tenant (null = none). */
  partition?: string | null;
}

/** POST /api/tickets: raise a ticket from your app (no email involved). */
export interface NewTicketInput {
  /** Mailbox address or id: the queue it lands in, and the sender of any email about it. */
  mailbox: string;
  subject: string;
  text: string;
  /** Default "portal". */
  source?: "portal" | "app";
  metadata?: Record<string, string>;
  /** Email the requester an acknowledgement. Default false. */
  ack?: boolean;
  /** Retries with the same key return the first ticket instead of opening another. */
  idempotencyKey?: string;
}

/** Staff raising a ticket on a customer's behalf name the customer. */
export interface StaffNewTicketInput extends NewTicketInput {
  requester: { email: string; name?: string; externalId?: string };
  /** Unrestricted callers: default the mailbox's partition. */
  partition?: string | null;
}

// ---- What requesters see (names only, never email addresses) ----

export interface RequesterTicket {
  ref: string;
  subject: string;
  status: TicketStatus;
  source: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, string>;
  /** Who raised it; isYou when it was the caller. */
  requester: { name: string; isYou: boolean };
}

export interface RequesterMessage {
  id: string;
  kind: "customer" | "ack" | "agent_reply";
  author: { name: string; staff: boolean; isYou: boolean };
  /** The first 500 characters; the full text is requester.messageText(id). */
  preview: string;
  createdAt: number;
  attachments: { id: string; filename: string | null; mimeType: string; size: number }[];
}

export interface RequesterTicketDetail {
  ticket: RequesterTicket;
  messages: RequesterMessage[];
}

export interface RequesterTicketPage {
  tickets: RequesterTicket[];
  nextCursor: string | null;
}
