// The point of the generated Prisma schema: a host app running `prisma db push` keeps the help
// desk's tables untouched. Runs against a real MySQL when MYSQL_URL is set (CI: mysql:8.4).
import { Kysely, MysqlDialect, sql } from "kysely";
import { createPool } from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate";
import { withTablePrefix } from "../src/prefix";
import { SqlRepo } from "../src/repo";
import type { Database } from "../src/schema";
import { prisma, prismaFolder } from "./prisma-helpers";

const url = process.env.MYSQL_URL;

if (!url) {
  describe.skip("Prisma round-trip on MySQL (set MYSQL_URL to run)", () => it("skipped", () => {}));
} else {
  const DB = "hd_prisma_roundtrip";
  const dbUrl = Object.assign(new URL(url), { pathname: `/${DB}` }).toString();
  const admin = new Kysely<unknown>({ dialect: new MysqlDialect({ pool: createPool({ uri: url, connectionLimit: 1 }) }) });
  const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool: createPool({ uri: dbUrl, connectionLimit: 2 }) }) });
  const diff = (schema: string) => {
    try {
      prisma(["migrate", "diff", "--from-url", dbUrl, "--to-schema-datamodel", schema, "--script", "--exit-code"]);
      return "";
    } catch (err) {
      return String((err as { stdout?: string }).stdout ?? err); // exit code 2 = there is a difference
    }
  };

  beforeAll(async () => {
    await sql`drop database if exists ${sql.id(DB)}`.execute(admin);
    await sql`create database ${sql.id(DB)}`.execute(admin);
    await applyMigrations(db, "mysql", undefined, { tablePrefix: "hd_" });
    // Data in the tables: a destructive change would need --accept-data-loss and fail the push.
    await new SqlRepo(withTablePrefix(db, "hd_"), "mysql", async () => {}).createMailbox({ address: "help@host.test", name: "Help", refPrefix: "HELP" });
  });
  afterAll(async () => {
    await db.destroy();
    await admin.destroy();
  });

  describe("Prisma round-trip on MySQL", () => {
    it("without the generated schema, Prisma would drop the help desk tables (control)", () => {
      expect(diff(prismaFolder({ withHelpdesk: false }))).toMatch(/DROP TABLE `hd_tickets`/);
    });

    it("with it, db push leaves them alone and the schemas match exactly", async () => {
      const schema = prismaFolder();
      const out = prisma(["db", "push", "--schema", schema, "--skip-generate"], { DATABASE_URL: dbUrl });
      expect(out).not.toMatch(/drop|data loss/i);
      expect(diff(schema)).toBe("");
      const rows = await sql<{ address: string }>`select address from hd_mailboxes`.execute(db);
      expect(rows.rows.map((r) => r.address)).toEqual(["help@host.test"]);
    });
  });
}
