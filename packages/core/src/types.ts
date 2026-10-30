export type TicketStatus = "new" | "open" | "pending" | "on_hold" | "solved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type MessageDirection = "inbound" | "outbound" | "note";

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

export const TICKET_STATUSES: TicketStatus[] = ["new", "open", "pending", "on_hold", "solved", "closed"];
export const TICKET_PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

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
  /** From the mailbox at creation. */
  partition: string | null;
}

/** Parsed inbound email, small enough to pass between Workflow steps (bodies live in R2). */
export interface InboundMessageMeta {
  ingestKey: string;
  mailboxAddress: string;
  envelopeFrom: string;
  from: { address: string; name: string | null };
  to: string[];
  cc: string[];
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  date: number | null;
  rawKey: string;
  textKey: string | null;
  htmlKey: string | null;
  textPreview: string;
  attachments: { key: string; filename: string | null; mimeType: string; size: number }[];
}
