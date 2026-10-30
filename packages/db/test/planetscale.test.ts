import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanetScaleRepo } from "../src/drivers/planetscale";

// The PlanetScale driver against a fake HTTP endpoint (no database needed). @planetscale/database 2.0
// dropped query parameters, which kysely-planetscale still passes, so every query failed in production:
// this runs parameterised queries through the real client and dialect to catch that kind of break.

const ROW = {
  id: "01MAILBOX",
  address: "o'brien@acme.test",
  name: "Acme",
  ref_prefix: "ACME",
  from_name: null,
  settings_json: '{"notifyNewTicket":["ops@acme.test"]}',
  created_at: "1761800000000",
  partition_key: null,
};

/** One result row in PlanetScale's wire format: values concatenated and base64-encoded, with lengths (-1 = NULL). */
function resultOf(row: Record<string, string | null>) {
  const cols = Object.keys(row);
  return {
    fields: cols.map((name) => ({ name, type: name === "created_at" ? "INT64" : "VARCHAR" })),
    rows: [{ lengths: cols.map((c) => String(row[c] === null ? -1 : row[c]!.length)), values: btoa(cols.map((c) => row[c] ?? "").join("")) }],
  };
}

const queries: string[] = [];
beforeEach(() => {
  queries.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://ps.example.test/psdb.v1alpha1.Database/Execute");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa("user:pscale_pw_x")}`);
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    queries.push(query);
    const result = /^select/i.test(query) ? resultOf(ROW) : { rowsAffected: "1" };
    return Response.json({ session: { s: 1 }, result, timing: 0.001 });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("PlanetScale driver (fake endpoint)", () => {
  it("runs parameterised queries, escaping values, with the table prefix", async () => {
    const repo = createPlanetScaleRepo("mysql://user:pscale_pw_x@ps.example.test/db", "hd_");
    const mb = await repo.getMailboxByAddress("O'Brien@Acme.test");
    expect(queries[0]).toBe("select * from `hd_mailboxes` where `address` = 'o''brien@acme.test'");
    expect(mb).toMatchObject({ id: "01MAILBOX", address: "o'brien@acme.test", fromName: null, notifyNewTicket: ["ops@acme.test"] });

    await repo.updateMailbox("01MAILBOX", { notifyNewTicket: ["lead@acme.test"] });
    const update = queries.find((q) => /^update/i.test(q));
    expect(update).toMatch(/^update `hd_mailboxes` set `settings_json` = '.*lead@acme\.test.*' where `id` = '01MAILBOX'$/);
  });

  it("wraps transactions in BEGIN/COMMIT, and ROLLBACK on error", async () => {
    const repo = createPlanetScaleRepo("mysql://user:pscale_pw_x@ps.example.test/db", "hd_");
    await repo.db.transaction().execute((tx) => tx.updateTable("mailboxes").set({ name: "A" }).where("id", "=", "x").execute());
    expect(queries).toEqual(["BEGIN", "update `hd_mailboxes` set `name` = 'A' where `id` = 'x'", "COMMIT"]);

    queries.length = 0;
    await expect(repo.db.transaction().execute(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
