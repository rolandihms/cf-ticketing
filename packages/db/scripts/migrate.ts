// Apply migrations to a Postgres or MySQL database (D1 uses `wrangler d1 migrations apply`).
//   npm run db:migrate -- --driver postgres --url postgres://user:pass@host:5432/db
//   npm run db:migrate -- --driver mysql --url mysql://user:pass@host:3306/db --table-prefix hd_
// Options: see MIGRATE_USAGE in src/node-migrate.ts.
import { runMigrateCli } from "../src/node-migrate";

process.exitCode = await runMigrateCli(process.argv.slice(2));
