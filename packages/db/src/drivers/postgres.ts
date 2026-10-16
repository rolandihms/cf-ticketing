import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { SqlRepo } from "../repo";
import type { Database } from "../schema";

// BIGINT (int8) comes back as string by default; our timestamps fit in a JS number.
// Per-pool override, so we don't mutate pg's process-global parser registry.
const types = {
  getTypeParser: (oid: number, format?: "text" | "binary") =>
    oid === 20 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as "text"),
};

export function createPostgresRepo(connectionString: string): SqlRepo {
  // Hyperdrive does the real pooling; a pool per invocation is what its docs recommend.
  const pool = new pg.Pool({ connectionString, max: 2, types: types as never });
  return new SqlRepo(new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), "postgres");
}
