// Apply migrations to Postgres or MySQL from Node (D1 uses `wrangler d1 migrations apply`).
// Shared by `npm run db:migrate` (scripts/migrate.ts) and `cf-helpdesk migrate`.
import { Kysely, MysqlDialect, PostgresDialect } from "kysely";
import { createPool } from "mysql2";
import pg from "pg";
import { applyMigrations } from "./migrate";

export const MIGRATE_USAGE = `usage: migrate --driver postgres|mysql [--url <connection-url>] [--table-prefix hd_] [--record-only]
  --url            defaults to DATABASE_URL
  --table-prefix   prefix every table and index (embedding into another app's database); TABLE_PREFIX also works
  --record-only    mark pending migrations as applied without running them (after a PlanetScale deploy request)
PlanetScale needs TLS: append ?ssl={"rejectUnauthorized":true} to the mysql:// URL.`;

/** Returns the process exit code. */
export async function runMigrateCli(argv: string[], log: (m: string) => void = console.log): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const driver = arg("driver");
  const url = arg("url") ?? process.env.DATABASE_URL;
  if (!url || (driver !== "postgres" && driver !== "mysql")) {
    console.error(MIGRATE_USAGE);
    return 2;
  }
  const db = new Kysely<any>({
    dialect:
      driver === "postgres"
        ? new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) })
        : new MysqlDialect({ pool: createPool({ uri: url, connectionLimit: 1 }) }),
  });
  try {
    const applied = await applyMigrations(db, driver, log, {
      recordOnly: argv.includes("--record-only"),
      tablePrefix: arg("table-prefix") ?? process.env.TABLE_PREFIX,
    });
    log(applied.length ? `done: ${applied.length} migration(s) ${argv.includes("--record-only") ? "recorded" : "applied"}` : "already up to date");
    return 0;
  } finally {
    await db.destroy();
  }
}
