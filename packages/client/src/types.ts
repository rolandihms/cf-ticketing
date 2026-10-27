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

export interface Principal {
  kind: "service" | "agent";
  role: AgentRole;
  /** Recorded on ticket events, e.g. "agent:01H…" or "api". */
  actor: string;
  agent?: Agent;
  /** The only partition this caller may see, or null for every partition. */
  partition: string | null;
  via: "token" | "access" | "trusted";
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
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
}
