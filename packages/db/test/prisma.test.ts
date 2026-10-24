import { describe, expect, it } from "vitest";
import { compileMigrations } from "../src/compile";
import type { Kysely } from "kysely";
import { migrations } from "../src/migrations";
import { renderPrismaSchema } from "../src/prisma";
import { prisma, prismaFolder } from "./prisma-helpers";

describe("renderPrismaSchema", () => {
  it("has a model for every table the migrations create, mapped to the prefixed name", () => {
    const schema = renderPrismaSchema({ tablePrefix: "hd_" });
    const created = compileMigrations("mysql", "hd_")
      .flatMap((m) => m.statements)
      .map((s) => s.match(/^create table `([^`]+)`/)?.[1])
      .filter(Boolean);
    const mapped = [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(mapped.sort()).toEqual([...created, "hd__helpdesk_migrations"].sort());
    expect(schema).toContain("model HdTickets {");
    expect(schema).toContain('@@index([status, updated_at], map: "hd_tickets_status_idx")');
    expect(schema).toContain("@@id([agent_id, partition_key])");
  });

  it("uses a different model prefix when asked, and 'Helpdesk' without a table prefix", () => {
    expect(renderPrismaSchema({ tablePrefix: "hd_", modelPrefix: "Support" })).toContain("model SupportTickets {");
    expect(renderPrismaSchema()).toContain('model HelpdeskTickets {\n');
  });

  it("refuses migrations it can't model instead of emitting a wrong schema", () => {
    const withDefault = [...migrations, { name: "9999_x", up: (db: Kysely<unknown>) => [db.schema.alterTable("tickets").addColumn("x", "integer", (c) => c.notNull().defaultTo(0))] }];
    expect(() => renderPrismaSchema({ migrations: withDefault })).toThrow(/defaultTo/);
    const partial = [...migrations, { name: "9999_y", up: (db: Kysely<unknown>) => [db.schema.createIndex("p_idx").on("tickets").column("status").where("status", "=", "open")] }];
    expect(() => renderPrismaSchema({ migrations: partial })).toThrow(/partial/);
    const drop = [...migrations, { name: "9999_z", up: (db: Kysely<unknown>) => [db.schema.alterTable("tickets").dropColumn("summary")] }];
    expect(() => renderPrismaSchema({ migrations: drop })).toThrow(/unsupported/);
  });

  it("is a valid Prisma schema next to a host schema (prisma validate)", () => {
    expect(prisma(["validate", "--schema", prismaFolder()])).toMatch(/valid/);
  });
});
