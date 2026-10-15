// Real Postgres server via the `pg` driver (the same driver used behind Hyperdrive).
// Runs when PG_URL is set (CI uses a postgres service container).
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { describe, it } from "vitest";
import { applyMigrations } from "../src/migrate";
import { SqlRepo } from "../src/repo";
import type { Database } from "../src/schema";
import { repoContract, TABLES } from "./repo-contract";

const url = process.env.PG_URL;

if (!url) {
  describe.skip("HelpdeskRepo contract: postgres server (set PG_URL to run)", () => it("skipped", () => {}));
} else {
  pg.types.setTypeParser(20, (v: string) => Number(v));
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) }) });
  let migrated = false;
  repoContract(
    "postgres (pg driver)",
    async () => {
      if (!migrated) {
        await applyMigrations(db, "postgres");
        migrated = true;
      }
      return new SqlRepo(db, "postgres", async () => {});
    },
    async () => {
      for (const t of TABLES) await sql`delete from ${sql.table(t)}`.execute(db);
    },
  );
}
