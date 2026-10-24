// CF Helpdesk setup: provision and deploy a help desk into your own Cloudflare account.
//   npm run setup                                    (interactive)
//   npm run setup -- --address support@acme.com --yes   (non-interactive, defaults for the rest)
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ADDRESS_RE,
  type AckMode,
  type Answers,
  type DbDriver,
  domainOf,
  prefixFromAddress,
  profileFromAddress,
} from "./answers";
import { runSetup, SetupError } from "./setup";
import { realWrangler } from "./wrangler";

const HELP = `
CF Helpdesk setup — deploys the help desk to your Cloudflare account.

Usage: npm run setup -- [options]

  --address <email>        Support address customers write to (e.g. support@acme.com)
  --name <text>            Display name in acknowledgements (default: "<Domain> Support")
  --ref-prefix <ABC>       Ticket prefix, e.g. ACME → ACME-000123 (default: from the domain)
  --worker <name>          Worker name; prefixes D1/R2/Workflow names (default: cf-helpdesk)
  --profile <name>         Writes apps/worker/wrangler.<profile>.jsonc (default: from the domain)
  --account-id <id>        Cloudflare account (asked if your login has several)
  --ack-mode <mode>        send (Workers Paid, any recipient) | reply (Free plan) | off  (default: send)
  --db <driver>            d1 (default) | postgres | mysql | planetscale
  --database-url <url>     Connection URL for postgres/mysql/planetscale
  --config-only            Create resources and write the config; don't migrate, deploy or touch mail routing
  --yes                    Non-interactive: accept defaults, and allow re-routing an address from another Worker
  --replace-mx             Allow replacing the domain's existing MX records (never implied by --yes)
  --help

Prerequisites: \`npx wrangler login\`, and the domain must be a zone in your Cloudflare account.
`;

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/worker");
const repoRoot = resolve(workerDir, "../..");

async function main() {
  const { values: f, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      address: { type: "string" },
      name: { type: "string" },
      "ref-prefix": { type: "string" },
      worker: { type: "string" },
      profile: { type: "string" },
      "account-id": { type: "string" },
      "ack-mode": { type: "string" },
      db: { type: "string" },
      "database-url": { type: "string" },
      "config-only": { type: "boolean" },
      yes: { type: "boolean" },
      "replace-mx": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (f.help || (positionals[0] && positionals[0] !== "setup")) return console.log(HELP);

  const interactive = !f.yes && process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q: string, def?: string, valid?: (v: string) => boolean): Promise<string> => {
    if (!rl) {
      if (def === undefined) throw new SetupError(`Missing value for: ${q} (pass it as a flag, or run interactively)`);
      return def;
    }
    for (;;) {
      const v = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim() || def || "";
      if (!valid || valid(v)) return v;
      console.log("  Invalid value, try again.");
    }
  };
  const confirm = async (q: string, kind: "mx" | "takeover") => {
    if (kind === "mx" && f["replace-mx"]) return true;
    if (kind === "takeover" && f.yes) return true;
    if (!rl) return false;
    return /^y(es)?$/i.test((await rl.question(`\n⚠  ${q} [y/N]: `)).trim());
  };

  let accountId = f["account-id"];
  const wrangler = realWrangler({ cwd: workerDir, accountId: () => accountId });

  try {
    console.log("\nCF Helpdesk setup\n");

    // Pick the account first (wrangler needs it for every other command when you have several).
    if (!accountId) {
      const who = await wrangler.run(["whoami", "--json"]);
      const accounts: { id: string; name: string }[] = (() => {
        try {
          return JSON.parse(who.stdout).accounts ?? [];
        } catch {
          return [];
        }
      })();
      if (!accounts.length) throw new SetupError("Not logged in to Cloudflare. Run `npx wrangler login` first.");
      if (accounts.length === 1) accountId = accounts[0]!.id;
      else {
        if (!rl) throw new SetupError(`Your login has ${accounts.length} accounts; pass --account-id (${accounts.map((x) => `${x.id} = ${x.name}`).join(", ")}).`);
        accounts.forEach((x, i) => console.log(`  ${i + 1}) ${x.name}  (${x.id})`));
        const pick = await ask("Cloudflare account", "1", (v) => Number(v) >= 1 && Number(v) <= accounts.length);
        accountId = accounts[Number(pick) - 1]!.id;
      }
    }

    const address = (f.address ?? (await ask("Support email address (e.g. support@acme.com)", undefined, (v) => ADDRESS_RE.test(v)))).toLowerCase();
    const domain = domainOf(address);
    const brand = domain.split(".")[0]!.replace(/^./, (c) => c.toUpperCase());
    const answers: Answers = {
      accountId: accountId!,
      address,
      mailboxName: f.name ?? (await ask("Name shown in replies", `${brand} Support`)),
      refPrefix: (f["ref-prefix"] ?? (await ask("Ticket prefix", prefixFromAddress(address)))).toUpperCase(),
      workerName: f.worker ?? (await ask("Worker name", "cf-helpdesk")),
      profile: f.profile ?? profileFromAddress(address),
      ackMode: (f["ack-mode"] ??
        (await ask("Acknowledge new tickets by email? send = needs Workers Paid ($5/mo) | reply = Free plan (DMARC-passing senders only) | off", "send", (v) =>
          ["send", "reply", "off"].includes(v),
        ))) as AckMode,
      db: (f.db ?? (await ask("Database: d1 | postgres | mysql | planetscale", "d1", (v) => ["d1", "postgres", "mysql", "planetscale"].includes(v)))) as DbDriver,
    };
    if (answers.db !== "d1") answers.databaseUrl = f["database-url"] ?? (await ask(`${answers.db} connection URL`));

    const result = await runSetup({
      wrangler,
      answers,
      workerDir,
      confirm,
      log: (m) => console.log(m),
      configOnly: f["config-only"],
      // The URL goes through the environment, not argv, so it doesn't show up in process listings.
      runMigrate: (driver, url) => npm(["run", "db:migrate", "--", "--driver", driver], { DATABASE_URL: url }),
    });

    console.log(`
✅ Done.

  Config:   ${result.configPath}
  Secrets:  ${result.secretsPath}   (API token for the REST API; keep it private)
  Worker:   ${result.workerUrl ?? (result.deployed ? "deployed (no workers.dev URL: create the mailbox via your own route)" : "not deployed (--config-only)")}
  Mailbox:  ${address} ${result.mailboxSeeded ? "✓ created" : "✗ not created yet"}
${
  result.mailboxSeeded || !result.deployed
    ? ""
    : `
  Create it with:
    curl -X POST ${result.workerUrl ?? "https://<your-worker-url>"}/api/mailboxes -H "authorization: Bearer <API_TOKEN from the secrets file>" \\
      -H 'content-type: application/json' -d '{"address":"${address}","name":"${answers.mailboxName}","refPrefix":"${answers.refPrefix}"}'
`
}
Next:
  • Wait 1–2 minutes for the new Email Routing rule to take effect. Mail sent earlier can be dropped
    by the domain's catch-all rule.
  • Then send an email to ${address}; you should get an acknowledgement with a ${answers.refPrefix}-000001 reference.
  • Watch it: cd apps/worker && CLOUDFLARE_ACCOUNT_ID=${answers.accountId} npx wrangler tail -c wrangler.${answers.profile}.jsonc
  • Redeploy after code changes: CLOUDFLARE_ACCOUNT_ID=${answers.accountId} npx wrangler deploy -c wrangler.${answers.profile}.jsonc
  • Optional integrations (GitHub issues, webhooks): docs/INTEGRATIONS.md
`);
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`\n✘ ${err.message}\n`);
      process.exitCode = 1;
    } else throw err;
  } finally {
    rl?.close();
  }
}

function npm(args: string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
    });
    p.on("close", (code) => (code === 0 ? ok() : fail(new SetupError(`npm ${args.slice(0, 2).join(" ")} failed (exit ${code})`))));
  });
}

void main();
