// Compiles src/migrations/*.ts into packages/db/migrations/<dialect>/<name>.sql.
// `--check` exits non-zero if the generated files are out of date (used in CI).
// Embedding into another app's database: render a prefixed copy somewhere else, e.g.
//   npm run db:generate -- --table-prefix hd_ --dialect mysql --out ../my-app/helpdesk/migrations
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMigrations, renderMigrationFile } from "../src/compile";
import { validateTablePrefix } from "../src/prefix";
import type { SqlDialect } from "../src/types";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const prefix = validateTablePrefix(arg("table-prefix"));
const out = arg("out");
if (prefix && !out) {
  console.error("--table-prefix needs --out <dir>: packages/db/migrations holds the unprefixed reference SQL.");
  process.exit(2);
}
const root = out ? resolve(out) : join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const dialects = (arg("dialect") ? [arg("dialect")] : ["sqlite", "postgres", "mysql"]) as SqlDialect[];
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const d of dialects) {
  mkdirSync(join(root, d), { recursive: true });
  for (const m of compileMigrations(d, prefix)) {
    const file = join(root, d, `${m.name}.sql`);
    const content = renderMigrationFile(d, m.name, m.statements, prefix);
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
