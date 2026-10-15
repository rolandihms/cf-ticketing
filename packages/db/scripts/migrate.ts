// Apply migrations to a Postgres or MySQL database (D1 uses `wrangler d1 migrations apply`).
//   npm run db:migrate -- --driver postgres --url postgres://user:pass@host:5432/db
//   npm run db:migrate -- --driver mysql --url mysql://user:pass@host:3306/db
// DATABASE_URL is used when --url is omitted.
//   --record-only   mark pending migrations as applied without running them (PlanetScale deploy requests)
// PlanetScale needs TLS: append ?ssl={"rejectUnauthorized":true} to the mysql:// URL.
import { Kysely, MysqlDialect, PostgresDialect } from "kysely";
import { createPool } from "mysql2";
import pg from "pg";
import { applyMigrations } from "../src/migrate";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const driver = arg("driver");
const url = arg("url") ?? process.env.DATABASE_URL;
if (!url || (driver !== "postgres" && driver !== "mysql")) {
  console.error("usage: migrate --driver postgres|mysql --url <connection-url>");
  process.exit(2);
}

const db = new Kysely<any>({
  dialect:
    driver === "postgres"
      ? new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) })
      : new MysqlDialect({ pool: createPool({ uri: url, connectionLimit: 1 }) }),
});

try {
  const applied = await applyMigrations(db, driver, console.log, { recordOnly: process.argv.includes("--record-only") });
  console.log(applied.length ? `done: ${applied.length} migration(s) applied` : "already up to date");
} finally {
  await db.destroy();
}
