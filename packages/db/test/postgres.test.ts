// Postgres via PGlite (real Postgres compiled to WASM): no server needed.
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { expect } from "vitest";
import { applyMigrations } from "../src/migrate";
import { withTablePrefix } from "../src/prefix";
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

// The same contract with a table prefix (embedding into another app's database).
const pgliteHd = new PGlite({ parsers: { 20: (v: string) => Number(v) } });
const dbHd = withTablePrefix(new Kysely<Database>({ dialect: new PGliteDialect({ pglite: pgliteHd }) }), "hd_");
let migratedHd = false;

repoContract(
  "postgres (PGlite, table prefix hd_)",
  async () => {
    if (!migratedHd) {
      await applyMigrations(dbHd, "postgres", undefined, { tablePrefix: "hd_" });
      expect(await applyMigrations(dbHd, "postgres", undefined, { tablePrefix: "hd_" })).toEqual([]);
      const tables = await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = 'public'`.execute(dbHd);
      expect(tables.rows.map((r) => r.tablename).filter((t) => !t.startsWith("hd_"))).toEqual([]);
      migratedHd = true;
    }
    return new SqlRepo(dbHd, "postgres", async () => {});
  },
  async () => {
    for (const t of TABLES) await sql`delete from ${sql.table(t)}`.execute(dbHd);
  },
);
