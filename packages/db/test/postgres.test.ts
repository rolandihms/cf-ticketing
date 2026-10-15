// Postgres via PGlite (real Postgres compiled to WASM): no server needed.
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { expect } from "vitest";
import { applyMigrations } from "../src/migrate";
import { SqlRepo } from "../src/repo";
import type { Database } from "../src/schema";
import { repoContract, TABLES } from "./repo-contract";

const pglite = new PGlite({ parsers: { 20: (v: string) => Number(v) } });
const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
let migrated = false;

repoContract(
  "postgres (PGlite)",
  async () => {
    if (!migrated) {
      await applyMigrations(db, "postgres");
      expect(await applyMigrations(db, "postgres")).toEqual([]); // idempotent
      migrated = true;
    }
    return new SqlRepo(db, "postgres", async () => {});
  },
  async () => {
    for (const t of TABLES) await sql`delete from ${sql.table(t)}`.execute(db);
  },
);
