import type { Compilable, Kysely, OperationNodeSource } from "kysely";
import type { SqlDialect } from "../types";
import * as m0001 from "./0001_init";
import * as m0002 from "./0002_provider_msgid_index";
import * as m0003 from "./0003_classification";
import * as m0004 from "./0004_partition_identity";
import * as m0005 from "./0005_agent_partitions";
import * as m0006 from "./0006_requesters";

export interface MigrationDef {
  name: string;
  /** Schema builders: compiled to SQL (compile.ts) and read as nodes for the Prisma schema (prisma.ts). */
  up: (db: Kysely<unknown>, d: SqlDialect) => (Compilable & OperationNodeSource)[];
}

/** Ordered list of migrations. Append only; never edit a released migration. */
export const migrations: MigrationDef[] = [
  { name: "0001_init", up: m0001.up },
  { name: "0002_provider_msgid_index", up: m0002.up },
  { name: "0003_classification", up: m0003.up },
  { name: "0004_partition_identity", up: m0004.up },
  { name: "0005_agent_partitions", up: m0005.up },
  { name: "0006_requesters", up: m0006.up },
];
