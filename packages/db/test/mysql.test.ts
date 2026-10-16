// MySQL integration: runs when MYSQL_URL is set (CI uses a mysql:8 service container).
import { Kysely, MysqlDialect, sql } from "kysely";
import { createPool } from "mysql2";
import { describe, it } from "vitest";
import { applyMigrations } from "../src/migrate";
import { SqlRepo } from "../src/repo";
import type { Database } from "../src/schema";
import { repoContract, TABLES } from "./repo-contract";

const url = process.env.MYSQL_URL;

if (!url) {
  describe.skip("HelpdeskRepo contract: mysql (set MYSQL_URL to run)", () => it("skipped", () => {}));
} else {
  const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool: createPool({ uri: url, connectionLimit: 10 }) }) });
  let migrated = false;
  repoContract(
    "mysql",
    async () => {
      if (!migrated) {
        await applyMigrations(db, "mysql");
        migrated = true;
      }
      return new SqlRepo(db, "mysql", async () => {});
    },
    async () => {
      for (const t of TABLES) await sql`delete from ${sql.table(t)}`.execute(db);
    },
  );
}
