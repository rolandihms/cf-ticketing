import { mkdtemp, readFile, stat, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Answers } from "../src/answers";
import { readConfig, renderConfig } from "../src/config";
import { findIdInTable, parseEnv, parseRoutingRules, runSetup, SetupError } from "../src/setup";
import { failed } from "../src/wrangler";
import type { RunResult, Wrangler } from "../src/wrangler";

const ACCOUNT = "96c506ef4e346a2cb3c221e1142cd89e";
const TEMPLATE = resolve(__dirname, "../../../apps/worker/wrangler.jsonc");
const D1_ID = "c5ccbe93-9b91-4476-8dea-b84756ade609";

const answers = (o: Partial<Answers> = {}): Answers => ({
  accountId: ACCOUNT,
  address: "support@acme.test",
  mailboxName: "Acme Support",
  refPrefix: "ACME",
  workerName: "cf-helpdesk",
  profile: "acme-test",
  ackMode: "send",
  db: "d1",
  ...o,
});

type Script = Record<string, Partial<RunResult> | ((args: string[]) => Partial<RunResult>)>;

/** Fake wrangler: responses keyed by the command's leading words; records every call. */
function fakeWrangler(script: Script) {
  const calls: { args: string[]; input?: string }[] = [];
  const w: Wrangler = {
    async run(args, opts) {
      calls.push({ args, input: opts?.input });
      const key = Object.keys(script)
        .filter((k) => args.join(" ").startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const r = key ? script[key]! : {};
      const res = typeof r === "function" ? r(args) : r;
      return { code: 0, stdout: "", stderr: "", ...res };
    },
  };
  return { w, calls, cmds: () => calls.map((c) => c.args.join(" ")) };
}

const freshAccount: Script = {
  "whoami --json": { stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: ACCOUNT, name: "Acme" }] }) },
  "email routing settings": { stdout: "Email Routing for acme.test:\n  Enabled:  false\n" },
  "email routing rules list": { stdout: "Catch-all rule: disabled, action: drop\n" },
  "email sending settings": { stdout: "", stderr: "✘ [ERROR] Email Sending is not enabled", code: 1 },
  "d1 list --json": { stdout: "[]" },
  "d1 create": { stdout: `✅ Successfully created DB 'cf-helpdesk'\n{ "d1_databases": [{ "binding": "DB", "database_name": "cf-helpdesk", "database_id": "${D1_ID}" }] }` },
  "r2 bucket list": { stdout: "Listing buckets...\nname:           other\n" },
  deploy: { stdout: "Uploaded cf-helpdesk\n  https://cf-helpdesk.acme.workers.dev\n" },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cfh-setup-"));
  await copyFile(TEMPLATE, join(dir, "wrangler.jsonc"));
});

const okFetch = (status = 201) => (async (url: string | URL | Request) => {
  if (String(url).startsWith("https://cloudflare-dns.com")) return Response.json({ Answer: [] });
  return new Response("{}", { status });
}) as typeof fetch;

describe("runSetup", () => {
  it("provisions a fresh account end to end, in a safe order", async () => {
    const f = fakeWrangler(freshAccount);
    const r = await runSetup({ wrangler: f.w, answers: answers(), workerDir: dir, confirm: async () => false, log: () => {}, fetch: okFetch(), sleep: async () => {} });

    expect(f.cmds()).toEqual([
      "whoami --json",
      "email routing settings acme.test",
      "email routing rules list acme.test",
      // reversible provisioning first …
      "email sending settings acme.test",
      "email sending enable acme.test",
      "d1 list --json",
      "d1 create cf-helpdesk",
      "r2 bucket list",
      "r2 bucket create cf-helpdesk-mail",
      "d1 migrations apply DB --remote -c wrangler.acme-test.jsonc",
      // … then the changes that affect live mail
      "email routing enable acme.test",
      "deploy -c wrangler.acme-test.jsonc",
      "secret put API_TOKEN -c wrangler.acme-test.jsonc",
    ]);
    expect(r).toMatchObject({ workerUrl: "https://cf-helpdesk.acme.workers.dev", mailboxSeeded: true, resources: { d1Id: D1_ID } });

    // The API token is generated, stored owner-only, and piped (not passed as an argument) to wrangler.
    const secrets = parseEnv(await readFile(r.secretsPath, "utf8"));
    expect(secrets.API_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(f.calls.at(-1)!.input).toBe(secrets.API_TOKEN);
    expect((await stat(r.secretsPath)).mode & 0o777).toBe(0o600);

    const cfg = readConfig(await readFile(r.configPath, "utf8"));
    expect(cfg).toMatchObject({ name: "cf-helpdesk", account_id: ACCOUNT, addresses: ["support@acme.test"] });
  });

  it("is idempotent: a re-run reuses everything and keeps the same API token", async () => {
    const existing: Script = {
      ...freshAccount,
      "email routing settings": { stdout: "  Enabled:  true\n" },
      "email routing rules list": { stdout: "Rule: abc\n  Matchers: to:support@acme.test\n  Actions:  worker:cf-helpdesk\n" },
      "email sending settings": { stdout: "  Enabled:            true\n" },
      "d1 list --json": { stdout: JSON.stringify([{ uuid: D1_ID, name: "cf-helpdesk" }]) },
      "r2 bucket list": { stdout: "name:           cf-helpdesk-mail\n" },
    };
    const first = await runSetup({ wrangler: fakeWrangler(existing).w, answers: answers(), workerDir: dir, confirm: async () => false, log: () => {}, fetch: okFetch(), sleep: async () => {} });
    const f = fakeWrangler(existing);
    const second = await runSetup({ wrangler: f.w, answers: answers(), workerDir: dir, confirm: async () => false, log: () => {}, fetch: okFetch(), sleep: async () => {} });
    expect(f.cmds().filter((c) => /enable|create/.test(c))).toEqual([]);
    expect(parseEnv(await readFile(second.secretsPath, "utf8")).API_TOKEN).toBe(parseEnv(await readFile(first.secretsPath, "utf8")).API_TOKEN);
  });

  it("refuses when no zone exists for the domain", async () => {
    const f = fakeWrangler({ ...freshAccount, "email routing settings": { stdout: "✘ [ERROR] Could not find zone for `acme.test`. Make sure the domain exists in your account." } });
    await expect(runSetup({ wrangler: f.w, answers: answers(), workerDir: dir, confirm: async () => true, log: () => {} })).rejects.toThrow(/No zone for acme\.test/);
    expect(f.cmds()).toEqual(["whoami --json", "email routing settings acme.test"]);
  });

  describe("subdomain addresses", () => {
    const sub: Script = {
      ...freshAccount,
      "email routing settings help.acme.test": { stdout: "✘ [ERROR] Could not find zone for `help.acme.test`." },
      "email routing settings acme.test": { stdout: "  Enabled:  true\n" },
    };
    it("finds the parent zone and never touches the apex MX", async () => {
      const cfMx = (async (u: string | URL | Request) =>
        String(u).includes("dns-query") ? Response.json({ Answer: [{ type: 15, data: "13 route1.mx.cloudflare.net." }] }) : new Response("{}", { status: 201 })) as typeof fetch;
      const f = fakeWrangler(sub);
      const r = await runSetup({ wrangler: f.w, answers: answers({ address: "support@help.acme.test" }), workerDir: dir, confirm: async () => false, log: () => {}, fetch: cfMx, sleep: async () => {} });
      expect(r.zone).toBe("acme.test");
      expect(f.cmds()).toContain("email routing rules list acme.test");
      expect(f.cmds()).toContain("email sending settings help.acme.test");
      expect(f.cmds().some((c) => c.startsWith("email routing enable"))).toBe(false);
    });
    it("explains the dashboard step when the subdomain isn't routed yet", async () => {
      const f = fakeWrangler(sub);
      await expect(
        runSetup({ wrangler: f.w, answers: answers({ address: "support@help.acme.test" }), workerDir: dir, confirm: async () => true, log: () => {}, fetch: okFetch() }),
      ).rejects.toThrow(/Email Routing → Settings → Subdomains/);
      expect(f.cmds().filter((c) => /enable|create|deploy/.test(c))).toEqual([]);
    });
  });

  it("on the Free plan, fails before touching mail routing (Email Sending refused)", async () => {
    const f = fakeWrangler({ ...freshAccount, "email sending enable": { code: 1, stderr: "✘ [ERROR] Workers Paid plan required" } });
    await expect(runSetup({ wrangler: f.w, answers: answers(), workerDir: dir, confirm: async () => true, log: () => {}, fetch: okFetch() })).rejects.toThrow(/--ack-mode reply/);
    expect(f.cmds().some((c) => c.startsWith("email routing enable") || c.startsWith("deploy"))).toBe(false);
  });

  it("never replaces existing MX records without confirmation", async () => {
    const gmail = (async () => Response.json({ Answer: [{ type: 15, data: "1 smtp.google.com." }] })) as typeof fetch;
    const kinds: string[] = [];
    const f = fakeWrangler(freshAccount);
    const asked: string[] = [];
    await expect(
      runSetup({ wrangler: f.w, answers: answers(), workerDir: dir, confirm: async (q, k) => (asked.push(q), kinds.push(k), false), log: () => {}, fetch: gmail }),
    ).rejects.toThrow(/MX records left untouched/);
    expect(kinds).toEqual(["mx"]);
    expect(f.cmds().filter((c) => /create|enable/.test(c))).toEqual([]); // asked before anything changed
    expect(asked[0]).toMatch(/smtp\.google\.com.*REPLACES/s);
    expect(f.cmds()).not.toContain("email routing enable acme.test");
  });

  it("asks before taking over an address, and removes the old rule just before deploying", async () => {
    const legacy: Script = { ...freshAccount, "email routing rules list": { stdout: "Rule: r123\n  Matchers: to:support@acme.test\n  Actions:  worker:legacy\n" } };
    await expect(runSetup({ wrangler: fakeWrangler(legacy).w, answers: answers(), workerDir: dir, confirm: async () => false, log: () => {}, fetch: okFetch() })).rejects.toThrow(/keeps its current routing/);

    const f = fakeWrangler(legacy);
    const kinds: string[] = [];
    await runSetup({ wrangler: f.w, answers: answers(), workerDir: dir, confirm: async (_q, k) => (kinds.push(k), true), log: () => {}, fetch: okFetch(), sleep: async () => {} });
    expect(kinds).toEqual(["takeover"]);
    const cmds = f.cmds();
    expect(cmds.indexOf("email routing rules delete acme.test r123 --force")).toBe(cmds.indexOf("deploy -c wrangler.acme-test.jsonc") - 1);
  });

  it("keeps addresses already in the profile on re-runs (wrangler would delete their rules)", async () => {
    await writeFile(join(dir, "wrangler.acme-test.jsonc"), JSON.stringify({ addresses: ["sales@acme.test"] }));
    const r = await runSetup({ wrangler: fakeWrangler(freshAccount).w, answers: answers(), workerDir: dir, confirm: async () => false, log: () => {}, fetch: okFetch(), sleep: async () => {} });
    expect(readConfig(await readFile(r.configPath, "utf8")).addresses).toEqual(["sales@acme.test", "support@acme.test"]);
  });

  it("skips Email Sending for ACK_MODE=reply and stops early with --config-only", async () => {
    const f = fakeWrangler(freshAccount);
    const r = await runSetup({ wrangler: f.w, answers: answers({ ackMode: "reply" }), workerDir: dir, confirm: async () => false, log: () => {}, fetch: okFetch(), configOnly: true });
    expect(f.cmds().some((c) => c.includes("sending"))).toBe(false);
    expect(f.cmds().some((c) => c.startsWith("deploy") || c.includes("migrations"))).toBe(false);
    expect(readConfig(await readFile(r.configPath, "utf8")).vars.ACK_MODE).toBe("reply");
  });

  it("uses Hyperdrive + the migrate CLI for Postgres", async () => {
    const f = fakeWrangler({ ...freshAccount, "hyperdrive list": { stdout: "┌─┐\n│ id │ name │\n│ ffffffffffffffffffffffffffffffff │ cf-helpdesk-db-old │\n" }, "hyperdrive create": { stdout: "Created Hyperdrive config\n id: 0123456789abcdef0123456789abcdef" } });
    const migrated: string[] = [];
    const r = await runSetup({
      wrangler: f.w,
      answers: answers({ db: "postgres", databaseUrl: "postgres://u:p@db.example:5432/hd" }),
      workerDir: dir, confirm: async () => false, log: () => {}, fetch: okFetch(), sleep: async () => {},
      runMigrate: async (d, url) => void migrated.push(`${d} ${url}`),
    });
    expect(migrated).toEqual(["postgres postgres://u:p@db.example:5432/hd"]);
    expect(f.cmds().some((c) => c.startsWith("d1 "))).toBe(false);
    const cfg = readConfig(await readFile(r.configPath, "utf8"));
    expect(cfg.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "0123456789abcdef0123456789abcdef" }]);
    expect(cfg.d1_databases).toBeUndefined();
    expect(cfg.define.__HELPDESK_DB_DRIVER__).toBe('"postgres"');
    // The database URL lives in Hyperdrive, never in the written config.
    expect(await readFile(r.configPath, "utf8")).not.toContain("u:p@");
  });

  it("validates answers before touching Cloudflare", async () => {
    const f = fakeWrangler(freshAccount);
    await expect(runSetup({ wrangler: f.w, answers: answers({ address: "nope", refPrefix: "a" }), workerDir: dir, confirm: async () => true, log: () => {} })).rejects.toThrow(SetupError);
    expect(f.calls).toHaveLength(0);
  });
});

describe("renderConfig", () => {
  it("keeps the template's comments and sets every per-deployment value", async () => {
    const template = await readFile(TEMPLATE, "utf8");
    const out = renderConfig(template, answers({ workerName: "acme-desk" }), { d1Id: D1_ID });
    expect(out).toContain("// Workers AI, used by the default LLM classifier");
    const cfg = readConfig(out);
    expect(cfg).toMatchObject({
      name: "acme-desk",
      addresses: ["support@acme.test"],
      d1_databases: [{ binding: "DB", database_name: "acme-desk", database_id: D1_ID }],
      r2_buckets: [{ binding: "MAIL", bucket_name: "acme-desk-mail" }],
      workflows: [{ binding: "INBOUND_WORKFLOW", name: "acme-desk-inbound", class_name: "InboundEmailWorkflow" }],
      vars: { DB_DRIVER: "d1", ACK_MODE: "send", DEFAULT_REF_PREFIX: "ACME" },
      define: { __HELPDESK_DB_DRIVER__: '"d1"' },
    });
  });
});

describe("parsers", () => {
  it("parseRoutingRules reads ids, addresses and worker actions", () => {
    const text = "Rule: a1\n  Matchers: to:Support@X.com\n  Actions:  worker:hd\n  Priority: 0\nRule: b2\n  Matchers: to:sales@x.com\n  Actions:  forward:me@y.com\n";
    expect(parseRoutingRules(text)).toEqual([
      { id: "a1", address: "support@x.com", worker: "hd" },
      { id: "b2", address: "sales@x.com", worker: null },
    ]);
  });
  it("findIdInTable matches the name cell exactly", () => {
    const table = [
      "┌──────────────────────────────────┬────────────────────┐",
      "│ id                               │ name               │",
      "│ ffffffffffffffffffffffffffffffff │ cf-helpdesk-db-old │",
      "│ 0123456789abcdef0123456789abcdef │ cf-helpdesk-db     │",
    ].join("\n");
    expect(findIdInTable(table, "cf-helpdesk-db")).toBe("0123456789abcdef0123456789abcdef");
    expect(findIdInTable(table, "nope")).toBeUndefined();
  });
  it("failed() only trusts wrangler's error marker at line start", () => {
    expect(failed({ code: 0, stdout: "✘ [ERROR] boom", stderr: "" })).toBe(true);
    expect(failed({ code: 0, stdout: "log: user typed [ERROR] in a message", stderr: "" })).toBe(false);
  });
});
