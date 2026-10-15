import type { Kysely } from "kysely";
import type { SqlDialect } from "../types";
import { columnTypes } from "./column-types";

/**
 * Classification results (docs/AI-PIPELINE.md §5) and links to external systems (GitHub issues).
 * Confidence is stored as an integer in thousandths to avoid float differences between dialects.
 */
export function up(db: Kysely<unknown>, d: SqlDialect) {
  const t = columnTypes(d);
  const fk = d !== "mysql";
  const s = db.schema;
  return [
    // One ALTER per column: SQLite only supports a single ADD COLUMN per statement.
    s.alterTable("tickets").addColumn("category", t.str(64)),
    s.alterTable("tickets").addColumn("category_confidence", t.int),
    s.alterTable("tickets").addColumn("code_related", t.bool),
    s.alterTable("tickets").addColumn("summary", t.text),
    s.createIndex("tickets_category_idx").on("tickets").columns(["category", "status"]),

    s.createTable("ticket_classifications")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("ticket_id", t.id, (c) => (fk ? c.notNull().references("tickets.id") : c.notNull()))
      .addColumn("message_id", t.id)
      .addColumn("classifier", t.str(64), (c) => c.notNull())
      .addColumn("provider", t.str(64))
      .addColumn("model", t.str(255))
      .addColumn("category", t.str(64))
      .addColumn("confidence", t.int)
      .addColumn("code_related", t.bool)
      .addColumn("accepted", t.bool, (c) => c.notNull())
      .addColumn("result_json", t.json)
      .addColumn("error_text", t.text)
      .addColumn("log_id", t.str(128))
      .addColumn("duration_ms", t.int)
      .addColumn("created_at", t.bigint, (c) => c.notNull()),
    s.createIndex("ticket_classifications_ticket_idx").on("ticket_classifications").columns(["ticket_id", "created_at"]),

    s.createTable("ticket_links")
      .addColumn("id", t.id, (c) => c.primaryKey())
      .addColumn("ticket_id", t.id, (c) => (fk ? c.notNull().references("tickets.id") : c.notNull()))
      .addColumn("provider", t.str(32), (c) => c.notNull())
      .addColumn("external_id", t.str(255), (c) => c.notNull())
      .addColumn("url", t.text)
      .addColumn("state", t.str(32))
      .addColumn("data_json", t.json)
      .addColumn("created_at", t.bigint, (c) => c.notNull())
      .addColumn("updated_at", t.bigint, (c) => c.notNull())
      .addUniqueConstraint("ticket_links_ticket_provider_uq", ["ticket_id", "provider"])
      .addUniqueConstraint("ticket_links_provider_external_uq", ["provider", "external_id"]),
  ];
}
