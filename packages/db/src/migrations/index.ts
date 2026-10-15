import type { Compilable, Kysely } from "kysely";
import type { SqlDialect } from "../types";
import * as m0001 from "./0001_init";
import * as m0002 from "./0002_provider_msgid_index";
import * as m0003 from "./0003_classification";

export interface MigrationDef {
  name: string;
  up: (db: Kysely<unknown>, d: SqlDialect) => Compilable[];
}

/** Ordered list of migrations. Append only; never edit a released migration. */
export const migrations: MigrationDef[] = [
  { name: "0001_init", up: m0001.up },
  { name: "0002_provider_msgid_index", up: m0002.up },
  { name: "0003_classification", up: m0003.up },
];
