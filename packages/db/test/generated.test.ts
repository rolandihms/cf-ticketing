import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMigrations, renderMigrationFile } from "../src/compile";
import type { SqlDialect } from "../src/types";

describe("generated migration SQL", () => {
  it.each(["sqlite", "postgres", "mysql"] as SqlDialect[])("is up to date for %s (run npm run db:generate)", (d) => {
    for (const m of compileMigrations(d)) {
      const file = readFileSync(join(__dirname, "..", "migrations", d, `${m.name}.sql`), "utf8");
      expect(file).toBe(renderMigrationFile(d, m.name, m.statements));
    }
  });

  it("emits no foreign keys for mysql (PlanetScale/Vitess compatibility)", () => {
    const all = compileMigrations("mysql").flatMap((m) => m.statements).join("\n");
    expect(all).not.toMatch(/references/i);
  });
});
