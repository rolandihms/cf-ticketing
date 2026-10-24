import { type Kysely, sql } from "kysely";
import { compileMigrations } from "./compile";
import { withTablePrefix } from "./prefix";
import type { SqlDialect } from "./types";

/** Bookkeeping table; gets the table prefix like every other table ("hd_" → hd__helpdesk_migrations). */
export const MIGRATIONS_TABLE = "_helpdesk_migrations";
const TABLE = MIGRATIONS_TABLE;

/**
 * Apply pending migrations for Postgres/MySQL (D1 uses `wrangler d1 migrations apply` with the same
 * generated SQL in migrations/sqlite). Works in Node and in Workers: SQL is compiled in-process.
 * Note: MySQL DDL auto-commits, so a failed migration can be partially applied there.
 */
export async function applyMigrations(
  db: Kysely<any>,
  dialect: SqlDialect,
  log: (m: string) => void = () => {},
  opts: { recordOnly?: boolean; tablePrefix?: string } = {},
) {
  const raw = db;
  db = withTablePrefix(db, opts.tablePrefix);
  await db.schema
    .createTable(TABLE)
    .ifNotExists()
    .addColumn("name", dialect === "sqlite" ? "text" : "varchar(255)", (c) => c.primaryKey())
    .addColumn("applied_at", "bigint", (c) => c.notNull())
    .execute();
  const done = new Set((await db.selectFrom(TABLE).select("name").execute()).map((r: { name: string }) => r.name));
  const applied: string[] = [];
  for (const m of compileMigrations(dialect, opts.tablePrefix)) {
    if (done.has(m.name)) continue;
    const run = async (conn: Kysely<any>) => {
      // recordOnly: the DDL was applied elsewhere (e.g. a PlanetScale deploy request); just record it.
      // Statements are already compiled with the prefix; the bookkeeping insert gets it from the plugin.
      if (!opts.recordOnly) for (const stmt of m.statements) await sql.raw(stmt).execute(conn);
      await withTablePrefix(conn, opts.tablePrefix).insertInto(TABLE).values({ name: m.name, applied_at: Date.now() }).execute();
    };
    // Postgres DDL is transactional, so each migration is all-or-nothing there.
    if (dialect === "postgres") await raw.transaction().execute(run);
    else await run(raw);
    applied.push(m.name);
    log(`${opts.recordOnly ? "recorded" : "applied"} ${m.name}`);
  }
  return applied;
}
