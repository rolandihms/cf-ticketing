import type { Kysely } from "kysely";
import type { SqlDialect } from "../types";
import { columnTypes } from "./column-types";

/**
 * Multi-tenant partitions and external identities (docs/EMBEDDING.md).
 * - partition_key: an opaque string chosen by the host app (e.g. "company:42"). A mailbox's partition
 *   is copied to its tickets; a principal restricted to a partition only sees that partition.
 *   (Not named "partition": that is a reserved word in MySQL.)
 * - agents.external_id: the host app's user id, for agents provisioned through a trusted principal.
 */
export function up(db: Kysely<unknown>, d: SqlDialect) {
  const t = columnTypes(d);
  const s = db.schema;
  return [
    s.alterTable("mailboxes").addColumn("partition_key", t.str(128)),
    s.alterTable("tickets").addColumn("partition_key", t.str(128)),
    s.alterTable("agents").addColumn("partition_key", t.str(128)),
    s.alterTable("agents").addColumn("external_id", t.str(128)),
    s.createIndex("tickets_partition_idx").on("tickets").columns(["partition_key", "id"]),
    s.createIndex("agents_external_id_uq").on("agents").column("external_id").unique(),
  ];
}
