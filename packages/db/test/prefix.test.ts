import { describe, expect, it } from "vitest";
import { compileMigrations } from "../src/compile";
import { validateTablePrefix } from "../src/prefix";
import type { SqlDialect } from "../src/types";

describe("table prefix", () => {
  it.each(["sqlite", "postgres", "mysql"] as SqlDialect[])("prefixes every table, index and named constraint (%s)", (d) => {
    const sql = compileMigrations(d, "hd_").flatMap((m) => m.statements).join("\n");
    const q = d === "mysql" ? "`" : '"';
    const names = [
      ...sql.matchAll(new RegExp(`(?:create table|alter table|create index|create unique index|on|references|constraint)\\s+${q}([a-z_]+)${q}`, "gi")),
    ].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => !n.startsWith("hd_"))).toEqual([]);
  });

  it("leaves the unprefixed SQL unchanged", () => {
    expect(compileMigrations("mysql", "")).toEqual(compileMigrations("mysql"));
  });

  it("accepts short identifiers only", () => {
    expect(validateTablePrefix("hd_")).toBe("hd_");
    expect(validateTablePrefix(undefined)).toBe("");
    for (const bad of ["HD_", "1x", "hd-", "a;drop", "x".repeat(17)]) expect(() => validateTablePrefix(bad)).toThrow(/Invalid table prefix/);
  });
});
