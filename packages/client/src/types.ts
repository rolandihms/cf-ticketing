// Wire types of the agent API (docs/AGENT-API.md). Tickets, agents and mailboxes are camelCase;
// messages, events and other rows are returned as stored (snake_case).
import type { Agent, AgentRole, Mailbox, Ticket, TicketPriority, TicketStatus } from "@cf-helpdesk/core";

export type { Agent, AgentRole, Mailbox, Ticket, TicketPriority, TicketStatus };

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
