// Run the shared HelpdeskRepo contract (packages/db/test) against real D1 in workerd.
import { compileMigrations, D1Dialect, D1Repo, withTablePrefix } from "@cf-helpdesk/db";
import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { expect, it } from "vitest";
import { repoContract, TABLES } from "../../../packages/db/test/repo-contract";

repoContract(
  "d1",
  async () => new D1Repo(env.DB, new Kysely({ dialect: new D1Dialect(env.DB) })),
  async () => {
    for (const t of TABLES) await env.DB.exec(`DELETE FROM ${t}`);
  },
);

// Corrupt settings_json must degrade to auto-detect (language null), never break reads.
it("tolerates a corrupt settings_json when reading a mailbox", async () => {
  const repo = new D1Repo(env.DB, new Kysely({ dialect: new D1Dialect(env.DB) }));
  const mailbox = await repo.createMailbox({ address: "corrupt@acme.test", name: "Corrupt", refPrefix: "CRPT", language: "zh" });
  await env.DB.prepare("UPDATE mailboxes SET settings_json = '{oops' WHERE id = ?").bind(mailbox.id).run();
  const reread = await repo.getMailboxByAddress("corrupt@acme.test");
  expect(reread).not.toBeNull();
  expect(reread!.language).toBeNull();
});

// Same contract with a table prefix, side by side with the unprefixed tables in the same D1 database
// (the embedding case: the help desk shares a database with another application).
const P = "hd_";
let prefixedReady = false;
repoContract(
  "d1 (table prefix hd_)",
  async () => {
    if (!prefixedReady) {
      for (const m of compileMigrations("sqlite", P)) for (const stmt of m.statements) await env.DB.prepare(stmt).run();
      const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 3) = ?").bind(P).all<{ name: string }>();
      expect(results.map((r) => r.name).sort()).toEqual(TABLES.map((t) => `${P}${t}`).sort());
      prefixedReady = true;
    }
    return new D1Repo(env.DB, withTablePrefix(new Kysely({ dialect: new D1Dialect(env.DB) }), P));
  },
  async () => {
    for (const t of TABLES) await env.DB.exec(`DELETE FROM ${P}${t}`);
  },
);
