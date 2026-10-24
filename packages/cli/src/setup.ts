import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Answers, domainOf, resourceNames, validateAnswers } from "./answers";
import { compileMigrations, renderMigrationFile } from "@cf-helpdesk/db/migrations";
import { prefixedMigrationsDir, readConfig, renderConfig, type Resources } from "./config";
import { checkMx } from "./dns";
import { errorText, failed, type Wrangler } from "./wrangler";

/** Kinds of risky change the user must approve. `mx` is never auto-approved by `--yes`. */
export type ConfirmKind = "mx" | "takeover";

export interface SetupContext {
  wrangler: Wrangler;
  answers: Answers;
  /** apps/worker */
  workerDir: string;
  /** Ask the user to approve a risky change. */
  confirm(question: string, kind: ConfirmKind): Promise<boolean>;
  log(msg: string): void;
  fetch?: typeof fetch;
  /** Apply Postgres/MySQL migrations (spawns `npm run db:migrate` with DATABASE_URL in env). */
  runMigrate?(driver: "postgres" | "mysql", url: string, tablePrefix?: string): Promise<void>;
  /** Wait between API retries; injected so tests don't sleep. */
  sleep?(ms: number): Promise<void>;
  /** Create resources and write the config, but change nothing about mail flow and don't deploy. */
  configOnly?: boolean;
}

export interface SetupResult {
  configPath: string;
  secretsPath: string;
  deployed: boolean;
  workerUrl: string | null;
  mailboxSeeded: boolean;
  resources: Resources;
  zone: string;
}

export class SetupError extends Error {}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
const HEX32 = /\b[0-9a-f]{32}\b/;

async function must(ctx: SetupContext, args: string[], what: string, input?: string) {
  const r = await ctx.wrangler.run(args, input === undefined ? undefined : { input });
  if (failed(r)) throw new SetupError(`${what} failed: ${errorText(r)}`);
  return r;
}

export interface RoutingRule {
  id: string;
  address: string;
  worker: string | null;
}

/** Parse `wrangler email routing rules list` (literal `to:` matchers only). */
export function parseRoutingRules(text: string): RoutingRule[] {
  const out: RoutingRule[] = [];
  for (const block of text.split(/\n(?=Rule: )/)) {
    const id = block.match(/^Rule:\s*(\S+)/m)?.[1];
    const to = block.match(/Matchers:\s*to:(\S+)/i)?.[1];
    if (!id || !to) continue;
    out.push({ id, address: to.toLowerCase(), worker: block.match(/Actions:\s*worker:(\S+)/i)?.[1] ?? null });
  }
  return out;
}

/** Find the row of a cli-table (`│ a │ b │`) whose cell equals `name` exactly, and return its 32-hex id. */
export function findIdInTable(table: string, name: string): string | undefined {
  for (const line of table.split("\n")) {
    const cells = line.split("│").map((c) => c.trim());
    if (cells.includes(name)) return cells.find((c) => HEX32.test(c) && c.length === 32);
  }
  return undefined;
}

/**
 * Find the Cloudflare zone for a domain by walking up its labels: help.acme.co.za → acme.co.za → co.za.
 * Wrangler's zone lookup is exact-name, so a subdomain address would otherwise look like "no zone".
 */
async function findZone(ctx: SetupContext, domain: string): Promise<{ zone: string; routingEnabled: boolean } | null> {
  const labels = domain.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join(".");
    const r = await ctx.wrangler.run(["email", "routing", "settings", candidate]);
    if (!failed(r)) return { zone: candidate, routingEnabled: /Enabled:\s*true/i.test(r.stdout) };
  }
  return null;
}

/**
 * Provision and deploy a help desk into the user's Cloudflare account. Safe to re-run.
 *
 * Ordering principle: ask every question first, then do everything reversible (Email Sending, database,
 * bucket, config, migrations), and only then the changes that affect live mail (enable Email Routing,
 * re-route an address, deploy). A failure part-way therefore never leaves a domain's mail broken.
 */
export async function runSetup(ctx: SetupContext): Promise<SetupResult> {
  const a = ctx.answers;
  const errors = validateAnswers(a);
  if (errors.length) throw new SetupError(`Invalid settings:\n  - ${errors.join("\n  - ")}`);
  const domain = domainOf(a.address);
  const names = resourceNames(a);
  const log = ctx.log;
  const resources: Resources = {};
  const configName = `wrangler.${a.profile}.jsonc`;
  const configPath = join(ctx.workerDir, configName);

  // ---- 1. Checks and questions (nothing is changed yet) ------------------------------------------

  log("Checking Cloudflare login…");
  const who = await ctx.wrangler.run(["whoami", "--json"]);
  let whoami: { loggedIn?: boolean; accounts?: { id: string; name: string }[] } = {};
  try {
    whoami = JSON.parse(who.stdout);
  } catch {
    /* handled below */
  }
  if (!whoami.loggedIn) throw new SetupError("Not logged in to Cloudflare. Run `npx wrangler login` first.");
  if (whoami.accounts && !whoami.accounts.some((x) => x.id === a.accountId)) {
    throw new SetupError(`Account ${a.accountId} is not available to this login.`);
  }

  log(`Finding the Cloudflare zone for ${domain}…`);
  const found = await findZone(ctx, domain);
  if (!found) throw new SetupError(`No zone for ${domain} in this Cloudflare account. Add the domain to Cloudflare first.`);
  const { zone } = found;
  const isSubdomain = zone !== domain;
  let enableRouting = false;

  if (isSubdomain) {
    // Subdomain Email Routing can only be switched on in the dashboard; never touch the apex MX here.
    const mx = await checkMx(domain, ctx.fetch).catch(() => null);
    if (!mx || mx.records.length === 0 || mx.foreign.length) {
      throw new SetupError(
        `${domain} is a subdomain of the zone ${zone}. Enable Email Routing for it first:\n` +
          `  Cloudflare dashboard → ${zone} → Email → Email Routing → Settings → Subdomains → add "${domain}".\n` +
          `Then re-run setup. (Its MX records must point to Cloudflare; found: ${mx?.records.join(", ") || "none"}.)`,
      );
    }
    log(`  ${domain} routes mail through Cloudflare (zone ${zone}).`);
  } else if (!found.routingEnabled) {
    const mx = await checkMx(zone, ctx.fetch).catch(() => null);
    if (mx === null) log(`  Could not look up MX records for ${zone}; continuing.`);
    else if (mx.foreign.length) {
      const ok = await ctx.confirm(
        `${zone} currently receives mail via ${mx.foreign.join(", ")}.\n` +
          `Enabling Cloudflare Email Routing REPLACES these MX records, so mail to every other address at ${zone} will stop arriving there.\n` +
          `A subdomain address (e.g. support@help.${zone}) avoids this. Replace the MX records?`,
        "mx",
      );
      if (!ok) throw new SetupError("Aborted: existing MX records left untouched. (Non-interactive runs need --replace-mx.)");
    }
    enableRouting = true;
  } else {
    log(`  Email Routing already enabled on ${zone}.`);
  }

  // Addresses already deployed for this profile are kept (wrangler deletes rules missing from `addresses`).
  const previous = existsSync(configPath) ? readConfig(await readFile(configPath, "utf8")) : null;
  const addresses = [...new Set([...((previous?.addresses as string[] | undefined) ?? []), a.address.toLowerCase()])];

  const rules = await ctx.wrangler.run(["email", "routing", "rules", "list", zone]);
  const conflicts = failed(rules)
    ? []
    : parseRoutingRules(rules.stdout).filter((r) => addresses.includes(r.address) && r.worker !== a.workerName);
  for (const c of conflicts) {
    const ok = await ctx.confirm(
      `${c.address} is currently routed to ${c.worker ? `the Worker "${c.worker}"` : "a non-Worker action"}. Re-route it to "${a.workerName}"?`,
      "takeover",
    );
    if (!ok) throw new SetupError(`Aborted: ${c.address} keeps its current routing.`);
  }

  // ---- 2. Reversible provisioning ---------------------------------------------------------------

  if (a.ackMode === "send") {
    const sending = await ctx.wrangler.run(["email", "sending", "settings", domain]);
    if (failed(sending) || !/Enabled:\s*true/i.test(sending.stdout)) {
      log(`Enabling Email Sending for ${domain} (adds SPF/DKIM/DMARC records)…`);
      const r = await ctx.wrangler.run(["email", "sending", "enable", domain]);
      if (failed(r)) {
        throw new SetupError(
          `Enabling Email Sending failed: ${errorText(r)}\n` +
            `Sending to any customer needs Workers Paid. On the Free plan, re-run with --ack-mode reply. Nothing about your mail has been changed.`,
        );
      }
    } else {
      log(`  Email Sending already enabled for ${domain}.`);
    }
  }

  if (a.db === "d1") {
    const list = await must(ctx, ["d1", "list", "--json"], "Listing D1 databases");
    const existing = (JSON.parse(list.stdout) as { uuid: string; name: string }[]).find((d) => d.name === names.d1);
    if (existing) {
      resources.d1Id = existing.uuid;
      log(`  Using existing D1 database ${names.d1}.`);
    } else {
      log(`Creating D1 database ${names.d1}…`);
      const created = await must(ctx, ["d1", "create", names.d1], "Creating the D1 database");
      resources.d1Id = created.stdout.match(UUID)?.[0];
      if (!resources.d1Id) throw new SetupError("Created the D1 database but could not read its id from wrangler's output.");
    }
  } else if (a.db === "postgres" || a.db === "mysql") {
    const list = await ctx.wrangler.run(["hyperdrive", "list"]);
    resources.hyperdriveId = failed(list) ? undefined : findIdInTable(list.stdout, names.hyperdrive);
    if (resources.hyperdriveId) log(`  Using existing Hyperdrive config ${names.hyperdrive}.`);
    else {
      log(`Creating Hyperdrive config ${names.hyperdrive}…`);
      // wrangler has no stdin option for this; the URL is briefly visible in the local process list.
      const created = await must(ctx, ["hyperdrive", "create", names.hyperdrive, `--connection-string=${a.databaseUrl}`], "Creating the Hyperdrive config");
      resources.hyperdriveId = created.stdout.match(HEX32)?.[0];
      if (!resources.hyperdriveId) throw new SetupError("Created the Hyperdrive config but could not read its id from wrangler's output.");
    }
  }

  const buckets = await must(ctx, ["r2", "bucket", "list"], "Listing R2 buckets");
  if (new RegExp(`^name:\\s*${names.bucket}\\s*$`, "m").test(buckets.stdout)) {
    log(`  Using existing R2 bucket ${names.bucket}.`);
  } else {
    log(`Creating R2 bucket ${names.bucket}…`);
    const r = await ctx.wrangler.run(["r2", "bucket", "create", names.bucket]);
    // Buckets in a jurisdiction (EU/FedRAMP) don't show in the default list.
    if (failed(r) && !/already exists/i.test(errorText(r))) throw new SetupError(`Creating the R2 bucket failed: ${errorText(r)}`);
  }

  if (a.db === "d1" && a.tablePrefix) {
    // `wrangler d1 migrations apply` reads SQL files, so render the prefixed set for this profile.
    const dir = join(ctx.workerDir, prefixedMigrationsDir(a.profile));
    await mkdir(dir, { recursive: true });
    for (const m of compileMigrations("sqlite", a.tablePrefix)) {
      await writeFile(join(dir, `${m.name}.sql`), renderMigrationFile("sqlite", m.name, m.statements, a.tablePrefix));
    }
    log(`Wrote prefixed migrations (${a.tablePrefix}) to ${dir}`);
  }

  const template = await readFile(join(ctx.workerDir, "wrangler.jsonc"), "utf8");
  await writeFile(configPath, renderConfig(template, { ...a, addresses }, resources));
  log(`Wrote ${configPath}`);

  // Secrets live in a gitignored, owner-only file so they are never lost (and never committed).
  const secretsDir = join(ctx.workerDir, ".helpdesk");
  const secretsPath = join(secretsDir, `${a.profile}.env`);
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const secrets = existsSync(secretsPath) ? parseEnv(await readFile(secretsPath, "utf8")) : {};
  secrets.API_TOKEN ??= randomBytes(24).toString("hex");
  const body = `# Secrets for profile "${a.profile}". Keep private.\n${Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
  await writeFile(secretsPath, body, { mode: 0o600 });
  await chmod(secretsPath, 0o600); // tighten an existing file too

  const result: SetupResult = { configPath, secretsPath, deployed: false, workerUrl: null, mailboxSeeded: false, resources, zone };
  if (ctx.configOnly) return result;

  // Migrations before the code that needs them is deployed.
  if (a.db === "d1") {
    log("Applying database migrations…");
    await must(ctx, ["d1", "migrations", "apply", "DB", "--remote", "-c", configName], "Applying D1 migrations");
  } else if (a.db === "planetscale") {
    log(
      (a.tablePrefix
        ? `  PlanetScale: render the prefixed SQL with \`npm run db:generate -- --table-prefix ${a.tablePrefix} --dialect mysql --out <dir>\`,\n` +
          "  apply it through a deploy request (see docs/DATABASE.md), then run\n" +
          `  \`npm run db:migrate -- --driver mysql --table-prefix ${a.tablePrefix} --record-only\` with DATABASE_URL set.`
        : "  PlanetScale: apply packages/db/migrations/mysql/*.sql through a deploy request\n" +
          "  (see docs/DATABASE.md), then run `npm run db:migrate -- --driver mysql --record-only` with DATABASE_URL set."),
    );
  } else {
    if (!ctx.runMigrate) throw new SetupError("No migration runner available for Postgres/MySQL.");
    log(`Applying ${a.db} migrations…`);
    await ctx.runMigrate(a.db, a.databaseUrl!, a.tablePrefix);
  }

  // ---- 3. Changes that affect live mail ---------------------------------------------------------

  if (enableRouting) {
    log(`Enabling Email Routing on ${zone}…`);
    await must(ctx, ["email", "routing", "enable", zone], "Enabling Email Routing");
  }
  // Remove approved conflicting rules first: in non-interactive mode wrangler refuses to take over
  // addresses during deploy (after the Worker is already uploaded).
  for (const c of conflicts) {
    log(`Removing the old routing rule for ${c.address}…`);
    await must(ctx, ["email", "routing", "rules", "delete", zone, c.id, "--force"], `Removing the routing rule for ${c.address}`);
  }

  log("Deploying the Worker…");
  const deploy = await must(ctx, ["deploy", "-c", configName], "Deploying");
  result.deployed = true;
  result.workerUrl = deploy.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;

  log("Setting secrets…");
  await must(ctx, ["secret", "put", "API_TOKEN", "-c", configName], "Setting API_TOKEN", secrets.API_TOKEN);
  if (a.db === "planetscale") await must(ctx, ["secret", "put", "DATABASE_URL", "-c", configName], "Setting DATABASE_URL", a.databaseUrl!);

  if (result.workerUrl) {
    log(`Creating mailbox ${a.address}…`);
    result.mailboxSeeded = await seedMailbox(ctx, result.workerUrl, secrets.API_TOKEN!);
  }
  return result;
}

async function seedMailbox(ctx: SetupContext, workerUrl: string, token: string): Promise<boolean> {
  const a = ctx.answers;
  const doFetch = ctx.fetch ?? fetch;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // A freshly deployed Worker and secret can take a few seconds to propagate.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await doFetch(`${workerUrl}/api/mailboxes`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ address: a.address, name: a.mailboxName, refPrefix: a.refPrefix, fromName: a.mailboxName }),
      });
      if (res.status === 201) return true;
      if (res.status !== 503 && res.status !== 401 && res.status < 500) return false;
    } catch {
      /* not reachable yet */
    }
    await sleep(3000);
  }
  return false;
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
