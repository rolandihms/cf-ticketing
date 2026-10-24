import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { compileMigrations } from "../src/compile";
import { applyMigrations } from "../src/migrate";
import { withTablePrefix } from "../src/prefix";

describe("applyMigrations", () => {
  it("refuses help desk tables it didn't create (e.g. by prisma db push), unless told to record them", async () => {
    const db = withTablePrefix(new Kysely<any>({ dialect: new PGliteDialect({ pglite: new PGlite() }) }), "hd_");
    // Someone else created the tables (no migration recorded).
    for (const m of compileMigrations("postgres", "hd_")) for (const s of m.statements) await sql.raw(s).execute(db.withoutPlugins());
    await expect(applyMigrations(db, "postgres", undefined, { tablePrefix: "hd_" })).rejects.toThrow(/no migration is recorded/);
    expect(await applyMigrations(db, "postgres", undefined, { tablePrefix: "hd_", recordOnly: true })).toHaveLength(compileMigrations("postgres").length);
    expect(await applyMigrations(db, "postgres", undefined, { tablePrefix: "hd_" })).toEqual([]);
    await db.destroy();
  });
});
