import type { Kysely } from "kysely";
import type { SqlDialect } from "../types";
import { columnTypes } from "./column-types";

/**
 * v1 schema. Written once with Kysely's schema builder and compiled per dialect by
 * scripts/generate.ts into migrations/<dialect>/0001_init.sql. Do not edit the generated SQL.
 *
 * Foreign keys are declared for sqlite/postgres. They are omitted for mysql so the same SQL runs
 * on PlanetScale/Vitess, where FK support is opt-in; integrity is enforced by the app there.
 */
export function up(db: Kysely<unknown>, d: SqlDialect) {
  const t = columnTypes(d);
  const fk = d !== "mysql";
  const s = db.schema;
  type Col = Parameters<Parameters<ReturnType<typeof s.createTable>["addColumn"]>[2] & {}>[0];
  const ref = (table: string) => (c: Col) => (fk ? c.references(`${table}.id`) : c);

  return [
    s.createTable("mailboxes")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("address", t.str(255), (c) => c.notNull().unique())
      .addColumn("name", t.str(255), (c) => c.notNull())
      .addColumn("ref_prefix", t.str(16), (c) => c.notNull())
      .addColumn("from_name", t.str(255))
      .addColumn("settings_json", t.json)
      .addColumn("created_at", t.bigint, (c) => c.notNull()),

    s.createTable("contacts")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("email", t.str(320), (c) => c.notNull().unique())
      .addColumn("name", t.str(255))
      .addColumn("created_at", t.bigint, (c) => c.notNull()),

    s.createTable("agents")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("email", t.str(320), (c) => c.notNull().unique())
      .addColumn("name", t.str(255), (c) => c.notNull())
      .addColumn("role", t.str(32), (c) => c.notNull())
      .addColumn("active", t.bool, (c) => c.notNull())
      .addColumn("created_at", t.bigint, (c) => c.notNull()),

    s.createTable("tickets")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("mailbox_id", t.id, (c) => ref("mailboxes")(c.notNull()))
      .addColumn("number", t.int, (c) => c.notNull())
      .addColumn("ref", t.str(64), (c) => c.notNull().unique())
      .addColumn("subject", t.text, (c) => c.notNull())
      .addColumn("status", t.str(32), (c) => c.notNull())
      .addColumn("priority", t.str(32), (c) => c.notNull())
      .addColumn("requester_id", t.id, (c) => ref("contacts")(c.notNull()))
      .addColumn("assignee_id", t.id, (c) => ref("agents")(c))
      .addColumn("source", t.str(32), (c) => c.notNull())
      .addColumn("source_ingest_key", t.hash, (c) => c.unique())
      .addColumn("tags_json", t.json)
      .addColumn("created_at", t.bigint, (c) => c.notNull())
      .addColumn("updated_at", t.bigint, (c) => c.notNull())
      .addColumn("closed_at", t.bigint)
      .addUniqueConstraint("tickets_mailbox_number_uq", ["mailbox_id", "number"]),
    s.createIndex("tickets_status_idx").on("tickets").columns(["status", "updated_at"]),
    s.createIndex("tickets_assignee_idx").on("tickets").columns(["assignee_id", "status"]),
    s.createIndex("tickets_requester_idx").on("tickets").column("requester_id"),

    s.createTable("messages")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("ticket_id", t.id, (c) => ref("tickets")(c.notNull()))
      .addColumn("mailbox_id", t.id, (c) => ref("mailboxes")(c.notNull()))
      .addColumn("direction", t.str(16), (c) => c.notNull())
      .addColumn("kind", t.str(32), (c) => c.notNull())
      .addColumn("ingest_key", t.hash, (c) => c.unique())
      .addColumn("message_id_hdr", t.str(512))
      .addColumn("provider_msg_id", t.str(512))
      .addColumn("in_reply_to", t.str(512))
      .addColumn("from_addr", t.str(320), (c) => c.notNull())
      .addColumn("to_json", t.json, (c) => c.notNull())
      .addColumn("cc_json", t.json)
      .addColumn("subject", t.text, (c) => c.notNull())
      .addColumn("text_preview", t.text)
      .addColumn("text_r2_key", t.str(512))
      .addColumn("html_r2_key", t.str(512))
      .addColumn("raw_r2_key", t.str(512))
      .addColumn("auth_json", t.json)
      .addColumn("author_agent_id", t.id, (c) => ref("agents")(c))
      .addColumn("created_at", t.bigint, (c) => c.notNull()),
    s.createIndex("messages_ticket_idx").on("messages").columns(["ticket_id", "created_at"]),
    s.createIndex("messages_mailbox_msgid_idx").on("messages").columns(["mailbox_id", "message_id_hdr"]),

    s.createTable("attachments")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("message_id", t.id, (c) => ref("messages")(c.notNull()))
      .addColumn("r2_key", t.str(512), (c) => c.notNull())
      .addColumn("filename", t.str(255))
      .addColumn("mime_type", t.str(255), (c) => c.notNull())
      .addColumn("size", t.bigint, (c) => c.notNull())
      .addColumn("created_at", t.bigint, (c) => c.notNull()),
    s.createIndex("attachments_message_idx").on("attachments").column("message_id"),

    s.createTable("ticket_events")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("ticket_id", t.id, (c) => ref("tickets")(c.notNull()))
      .addColumn("type", t.str(64), (c) => c.notNull())
      .addColumn("actor", t.str(128), (c) => c.notNull())
      .addColumn("data_json", t.json)
      .addColumn("created_at", t.bigint, (c) => c.notNull()),
    s.createIndex("ticket_events_ticket_idx").on("ticket_events").columns(["ticket_id", "created_at"]),

    s.createTable("counters")
      .addColumn("scope", t.str(128), (c) => c.primaryKey())
      .addColumn("value", t.bigint, (c) => c.notNull()),
  ];
}
