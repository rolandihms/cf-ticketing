// Kysely table types. Column names match migrations/0001_init.sql.
export interface MailboxesTable {
  id: string;
  address: string;
  name: string;
  ref_prefix: string;
  from_name: string | null;
  settings_json: string | null;
  created_at: number;
  partition_key: string | null;
}

export interface ContactsTable {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
}

export interface AgentsTable {
  id: string;
  email: string;
  name: string;
  role: string;
  active: number;
  created_at: number;
  partition_key: string | null;
  external_id: string | null;
}

export interface TicketsTable {
  id: string;
  mailbox_id: string;
  number: number;
  ref: string;
  subject: string;
  status: string;
  priority: string;
  requester_id: string;
  assignee_id: string | null;
  source: string;
  source_ingest_key: string | null;
  tags_json: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  category: string | null;
  /** Thousandths (0–1000). */
  category_confidence: number | null;
  code_related: number | null;
  summary: string | null;
  partition_key: string | null;
}

export interface MessagesTable {
  id: string;
  ticket_id: string;
  mailbox_id: string;
  direction: string;
  kind: string;
  ingest_key: string | null;
  message_id_hdr: string | null;
  provider_msg_id: string | null;
  in_reply_to: string | null;
  from_addr: string;
  to_json: string;
  cc_json: string | null;
  subject: string;
  text_preview: string | null;
  text_r2_key: string | null;
  html_r2_key: string | null;
  raw_r2_key: string | null;
  auth_json: string | null;
  author_agent_id: string | null;
  created_at: number;
}

export interface AttachmentsTable {
  id: string;
  message_id: string;
  r2_key: string;
  filename: string | null;
  mime_type: string;
  size: number;
  created_at: number;
}

export interface TicketEventsTable {
  id: string;
  ticket_id: string;
  type: string;
  actor: string;
  data_json: string | null;
  created_at: number;
}

export interface TicketClassificationsTable {
  id: string;
  ticket_id: string;
  message_id: string | null;
  classifier: string;
  provider: string | null;
  model: string | null;
  category: string | null;
  /** Thousandths (0–1000). */
  confidence: number | null;
  code_related: number | null;
  accepted: number;
  result_json: string | null;
  error_text: string | null;
  log_id: string | null;
  duration_ms: number | null;
  created_at: number;
}

export interface TicketLinksTable {
  id: string;
  ticket_id: string;
  provider: string;
  external_id: string;
  url: string | null;
  state: string | null;
  data_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface CountersTable {
  scope: string;
  value: number;
}

export interface Database {
  mailboxes: MailboxesTable;
  contacts: ContactsTable;
  agents: AgentsTable;
  tickets: TicketsTable;
  messages: MessagesTable;
  attachments: AttachmentsTable;
  ticket_events: TicketEventsTable;
  counters: CountersTable;
  ticket_classifications: TicketClassificationsTable;
  ticket_links: TicketLinksTable;
}
