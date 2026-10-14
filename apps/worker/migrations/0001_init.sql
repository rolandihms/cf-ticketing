-- CF Helpdesk schema v1 (SQLite / D1).
-- Portability rules: app-generated ULID ids, epoch-ms INTEGER timestamps, JSON stored as TEXT,
-- no DB defaults/triggers. Postgres/MySQL equivalents arrive in Phase 2.

CREATE TABLE mailboxes (
  id            TEXT PRIMARY KEY,
  address       TEXT NOT NULL UNIQUE,          -- lower-cased
  name          TEXT NOT NULL,
  ref_prefix    TEXT NOT NULL,
  from_name     TEXT,
  settings_json TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE contacts (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,             -- lower-cased
  name       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,                    -- admin | agent
  active     INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tickets (
  id                TEXT PRIMARY KEY,
  mailbox_id        TEXT NOT NULL REFERENCES mailboxes(id),
  number            INTEGER NOT NULL,
  ref               TEXT NOT NULL UNIQUE,
  subject           TEXT NOT NULL,
  status            TEXT NOT NULL,             -- new | open | pending | on_hold | solved | closed
  priority          TEXT NOT NULL,             -- low | normal | high | urgent
  requester_id      TEXT NOT NULL REFERENCES contacts(id),
  assignee_id       TEXT REFERENCES agents(id),
  source            TEXT NOT NULL,             -- email | api | web
  source_ingest_key TEXT UNIQUE,               -- ingest key of the email that created it
  tags_json         TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER,
  UNIQUE (mailbox_id, number)
);
CREATE INDEX tickets_status_idx ON tickets (status, updated_at);
CREATE INDEX tickets_assignee_idx ON tickets (assignee_id, status);
CREATE INDEX tickets_requester_idx ON tickets (requester_id);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id),
  mailbox_id      TEXT NOT NULL REFERENCES mailboxes(id),
  direction       TEXT NOT NULL,               -- inbound | outbound | note
  kind            TEXT NOT NULL,               -- customer | ack | agent_reply | note | system
  ingest_key      TEXT UNIQUE,                 -- inbound only; dedupe key
  message_id_hdr  TEXT,                        -- normalised <id@host>
  provider_msg_id TEXT,                        -- id returned by Email Sending, if any
  in_reply_to     TEXT,
  from_addr       TEXT NOT NULL,
  to_json         TEXT NOT NULL,
  cc_json         TEXT,
  subject         TEXT NOT NULL,
  text_preview    TEXT,
  text_r2_key     TEXT,
  html_r2_key     TEXT,
  raw_r2_key      TEXT,
  auth_json       TEXT,                        -- guard reasons / auth results
  author_agent_id TEXT REFERENCES agents(id),
  created_at      INTEGER NOT NULL
);
CREATE INDEX messages_ticket_idx ON messages (ticket_id, created_at);
CREATE INDEX messages_mailbox_msgid_idx ON messages (mailbox_id, message_id_hdr);

CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  r2_key     TEXT NOT NULL,
  filename   TEXT,
  mime_type  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_message_idx ON attachments (message_id);

CREATE TABLE ticket_events (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  data_json  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);

CREATE TABLE counters (
  scope TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
