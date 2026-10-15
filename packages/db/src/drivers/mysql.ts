import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
import { SqlRepo } from "../repo";
import type { Database } from "../schema";

export function createMysqlRepo(uri: string): SqlRepo {
  // disableEval: Workers forbid eval(); required by Hyperdrive's mysql2 guidance.
  const pool = createPool({ uri, connectionLimit: 2, disableEval: true });
  return new SqlRepo(new Kysely<Database>({ dialect: new MysqlDialect({ pool }) }), "mysql");
}
