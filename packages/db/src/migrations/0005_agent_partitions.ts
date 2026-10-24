import type { Kysely } from "kysely";
import type { SqlDialect } from "../types";
import { columnTypes } from "./column-types";

/**
 * Partitions a host-provisioned (trusted principal) agent has worked in. Such agents get their
 * partition per request, so the agent row stays unrestricted; this table records where they belong,
 * so tenants only see and assign their own staff. "*" = the host sent partition null (all partitions).
 */
export function up(db: Kysely<unknown>, d: SqlDialect) {
  const t = columnTypes(d);
  const s = db.schema;
  return [
    s.createTable("agent_partitions")
      .addColumn("agent_id", t.id, (c) => (d === "mysql" ? c.notNull() : c.notNull().references("agents.id")))
      .addColumn("partition_key", t.str(128), (c) => c.notNull())
      .addColumn("created_at", t.bigint, (c) => c.notNull())
      .addPrimaryKeyConstraint("agent_partitions_pk", ["agent_id", "partition_key"]),
    s.createIndex("agent_partitions_partition_idx").on("agent_partitions").column("partition_key"),
  ];
}
