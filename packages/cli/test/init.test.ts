import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { findPrismaDir, type InitOptions, planInit, writeInit } from "../src/init";

const TEMPLATE = resolve(__dirname, "../../../apps/worker/wrangler.jsonc");
let cwd: string;
const opts = (o: Partial<InitOptions> = {}): InitOptions => ({
  cwd,
  dir: "helpdesk",
  tablePrefix: "hd_",
  db: "planetscale",
  workerName: "helpdesk",
  deps: { kind: "npm", version: "0.1.0" },
  templatePath: TEMPLATE,
  ...o,
});
const read = (p: string) => readFile(join(cwd, p), "utf8");

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hd-init-"));
});

async function withPrisma(...dirs: string[]) {
  for (const d of dirs) {
    await mkdir(join(cwd, d), { recursive: true });
    await writeFile(join(cwd, d, "schema.prisma"), 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n');
  }
}

describe("cf-helpdesk init", () => {
  it("writes the Worker package, prefixed SQL and Prisma models into a PlanetScale project", async () => {
    await withPrisma("server/prisma");
    const plan = await planInit(opts());
    await writeInit(cwd, plan.files);

    const cfg = readConfig(await read("helpdesk/wrangler.jsonc"));
    expect(cfg).toMatchObject({
      name: "helpdesk",
      main: "src/index.ts",
      workers_dev: false,
      define: { __HELPDESK_DB_DRIVER__: '"planetscale"' },
      vars: { DB_DRIVER: "planetscale", TABLE_PREFIX: "hd_", TRUSTED_PRINCIPAL: "on" },
      workflows: [{ name: "helpdesk-inbound", class_name: "InboundEmailWorkflow" }],
      r2_buckets: [{ bucket_name: "helpdesk-mail" }],
    });
    expect(cfg.d1_databases).toBeUndefined();
    expect(cfg.hyperdrive).toBeUndefined();
    expect(await read("helpdesk/src/index.ts")).toContain("createHelpdesk(config)");
    expect(JSON.parse(await read("helpdesk/package.json")).dependencies["@rolandihms/helpdesk-worker"]).toBe("^0.1.0");
    expect(await read("helpdesk/migrations/mysql/0001_init.sql")).toContain("create table `hd_tickets`");
    expect(await read("server/prisma/helpdesk.prisma")).toContain('@@map("hd_tickets")');
    expect(plan.notes.join("\n")).toMatch(/whole folder/);
  });

  it("keeps files meant for editing on re-runs but refreshes generated ones", async () => {
    await withPrisma("prisma");
    await writeInit(cwd, (await planInit(opts())).files);
    await writeFile(join(cwd, "helpdesk/helpdesk.config.ts"), "// mine");
    await writeFile(join(cwd, "prisma/helpdesk.prisma"), "// stale");
    const report = await writeInit(cwd, (await planInit(opts())).files);
    expect(await read("helpdesk/helpdesk.config.ts")).toBe("// mine");
    expect(report.find((r) => r.path === "helpdesk/helpdesk.config.ts")?.action).toBe("kept");
    expect(report.find((r) => r.path === "prisma/helpdesk.prisma")?.action).toBe("updated");
    expect(report.find((r) => r.path.endsWith("0001_init.sql"))?.action).toBe("unchanged");
    await writeInit(cwd, (await planInit(opts())).files, true);
    expect(await read("helpdesk/helpdesk.config.ts")).toContain("defineHelpdesk");
  });

  it("D1: sqlite migrations and their own migrations table; Postgres: Hyperdrive and no Prisma models", async () => {
    await writeInit(cwd, (await planInit(opts({ db: "d1", prismaDir: "none" }))).files);
    const cfg = readConfig(await read("helpdesk/wrangler.jsonc"));
    expect(cfg.d1_databases[0]).toMatchObject({ database_name: "helpdesk", migrations_dir: "migrations/sqlite", migrations_table: "hd_d1_migrations" });
    expect(await read("helpdesk/migrations/sqlite/0001_init.sql")).toContain('create table "hd_tickets"');

    await withPrisma("prisma");
    const pg = await planInit(opts({ db: "postgres", dir: "hd2" }));
    expect(pg.files.some((f) => f.path.endsWith("helpdesk.prisma"))).toBe(false);
    expect(pg.notes.join()).toMatch(/MySQL\/PlanetScale for now/);
    expect(readConfig(pg.files.find((f) => f.path === "hd2/wrangler.jsonc")!.content).hyperdrive).toHaveLength(1);
  });

  it("links this checkout with file: dependencies relative to the Worker folder", async () => {
    const plan = await planInit(opts({ deps: { kind: "file", packagesDir: join(cwd, "vendor/cf-ticketing/packages") }, prismaDir: "none" }));
    const pkg = JSON.parse(plan.files.find((f) => f.path === "helpdesk/package.json")!.content);
    expect(pkg.dependencies["@rolandihms/helpdesk-worker"]).toBe("file:../vendor/cf-ticketing/packages/worker");
  });

  it("finds a single Prisma schema folder and refuses to guess between several", async () => {
    expect(findPrismaDir(cwd)).toBeNull();
    await withPrisma("server/prisma");
    expect(findPrismaDir(cwd)).toBe("server/prisma");
    await withPrisma("tools/prisma");
    expect(findPrismaDir(cwd)).toBeNull();
    expect((await planInit(opts())).notes.join()).toMatch(/--prisma-dir/);
  });

  it("validates the prefix and the worker name", async () => {
    await expect(planInit(opts({ tablePrefix: "HD-" }))).rejects.toThrow(/table-prefix/);
    await expect(planInit(opts({ workerName: "Bad Name" }))).rejects.toThrow(/--worker/);
  });
});
