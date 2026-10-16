// Compiles src/migrations/*.ts into packages/db/migrations/<dialect>/<name>.sql.
// `--check` exits non-zero if the generated files are out of date (used in CI).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMigrations, renderMigrationFile } from "../src/compile";
import type { SqlDialect } from "../src/types";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const d of ["sqlite", "postgres", "mysql"] as SqlDialect[]) {
  mkdirSync(join(root, d), { recursive: true });
  for (const m of compileMigrations(d)) {
    const file = join(root, d, `${m.name}.sql`);
    const content = renderMigrationFile(d, m.name, m.statements);
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current === content) continue;
    if (check) stale.push(file);
    else {
      writeFileSync(file, content);
      console.log(`wrote ${file}`);
    }
  }
}

if (stale.length) {
  console.error(`Generated migrations are out of date:\n  ${stale.join("\n  ")}\nRun: npm run db:generate`);
  process.exit(1);
}
