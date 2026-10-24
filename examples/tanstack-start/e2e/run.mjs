// End-to-end check of the embedding contract, in a real browser:
//   help desk Worker (wrangler dev --local) ← service binding ← this TanStack Start app (vite dev) ← Chrome
// 1. seeds a partitioned mailbox and delivers an email through the local email handler,
// 2. as an Acme agent: finds the ticket, assigns it, replies (status → pending), adds a note,
// 3. as a Globex agent: sees no tickets and gets "not in your company" for Acme's ticket.
// Usage: npm run e2e -w examples/tanstack-start   (CHROME=/path/to/chrome to override)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const root = resolve(app, "../..");
const worker = join(root, "apps/worker");
const bin = (name) => join(root, "node_modules/.bin", name);
const tmp = mkdtempSync(join(tmpdir(), "hd-e2e-"));
const HD = "http://localhost:8787";
const APP = "http://localhost:5173";
const TOKEN = "e2e-token";

// The app's service key comes from its .dev.vars (created from the example if missing); the help desk gets the same.
const devVars = join(app, ".dev.vars");
if (!existsSync(devVars)) writeFileSync(devVars, readFileSync(join(app, ".dev.vars.example"), "utf8"));
const serviceKey = readFileSync(devVars, "utf8").match(/^HELPDESK_SERVICE_KEY=(.*)$/m)?.[1]?.trim();
if (!serviceKey) throw new Error(`HELPDESK_SERVICE_KEY missing in ${devVars}`);

const children = [];
const run = (cmd, args, cwd, logName) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let log = "";
    p.stdout.on("data", (d) => (log += d));
    p.stderr.on("data", (d) => (log += d));
    if (logName) {
      children.push({ p, log: () => log, logName });
      ok(p);
    } else p.on("close", (c) => (c === 0 ? ok(log) : fail(new Error(`${cmd} ${args.join(" ")} failed:\n${log}`))));
  });
const waitFor = async (url, what) => {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start (${url})`);
};

let browser;
let failed = false;
try {
  // ---- help desk Worker, local only (remote bindings like Workers AI are off; classification falls back) ----
  await run(bin("wrangler"), ["d1", "migrations", "apply", "DB", "--local", "--persist-to", join(tmp, "state")], worker);
  await run(
    bin("wrangler"),
    ["dev", "--local", "--port", "8787", "--persist-to", join(tmp, "state"), "--var", "TRUSTED_PRINCIPAL:on", "--var", `HELPDESK_SERVICE_KEY:${serviceKey}`, "--var", `API_TOKEN:${TOKEN}`, "--var", "WEBHOOK_URL:"],
    worker,
    "helpdesk",
  );
  await waitFor(`${HD}/health`, "help desk Worker");
  // ---- this app ----
  await run(bin("vite"), ["dev", "--port", "5173", "--strictPort"], app, "app");
  await waitFor(`${APP}/api/session`, "reference app");

  // ---- seed ----
  const mb = await fetch(`${HD}/api/mailboxes`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ address: "support@acme.example", name: "Acme Support", refPrefix: "ACME", partition: "company:acme" }),
  });
  if (!mb.ok) throw new Error(`mailbox: HTTP ${mb.status}`);
  const subject = `Gate remote broken ${Date.now()}`;
  const mail = [
    "From: Jane <jane@cust.example>", "To: support@acme.example", `Subject: ${subject}`, `Message-ID: <${Date.now()}@cust.example>`,
    `Date: ${new Date().toUTCString()}`, "Content-Type: text/plain", "", "The gate remote stopped working.", "",
  ].join("\r\n");
  const sent = await fetch(`${HD}/cdn-cgi/handler/email?from=jane@cust.example&to=support@acme.example`, { method: "POST", body: mail });
  if (!sent.ok) throw new Error(`email: HTTP ${sent.status} ${await sent.text()}`);
  let ref;
  for (let i = 0; i < 40 && !ref; i++) {
    const r = await fetch(`${HD}/api/tickets?q=${encodeURIComponent(subject)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    ref = (await r.json()).tickets?.[0]?.ref;
    if (!ref) await new Promise((r) => setTimeout(r, 250));
  }
  if (!ref) throw new Error("the email did not become a ticket");
  console.log(`✓ email → ${ref}`);

  // ---- browser ----
  browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const text = (s, timeout = 15_000) => page.waitForFunction((s) => document.body.innerText.includes(s), { timeout }, s);
  const shot = (name) => {
    if (!process.env.E2E_SHOTS) return;
    mkdirSync(process.env.E2E_SHOTS, { recursive: true });
    return page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`), fullPage: true });
  };
  const clickButton = (label) => page.$$eval("button", (bs, label) => bs.find((b) => b.textContent === label)?.click(), label);

  await page.goto(`${APP}/`, { waitUntil: "networkidle0" });
  await page.select("select[aria-label='Demo user']", "acme-agent");
  await text(ref);
  await shot("1-inbox");
  console.log("✓ Acme agent sees the ticket in the inbox");

  await page.click(`a[href='/tickets/${ref}']`);
  await text("The gate remote stopped working.");
  await clickButton("Assign to me");
  await page.waitForFunction(() => [...document.querySelectorAll("select")].some((s) => s.options[s.selectedIndex]?.text === "Ann"), { timeout: 15_000 });
  console.log("✓ assigned to me");

  await page.type("textarea", "A new remote is on its way.");
  await clickButton("Send reply");
  await text("A new remote is on its way.");
  await page.waitForFunction(() => document.querySelector("fieldset select")?.value === "pending", { timeout: 15_000 });
  console.log("✓ reply sent, ticket pending");

  await page.click("input[type=radio]:not(:checked)");
  await page.type("textarea", "Customer is on the legacy plan.");
  await clickButton("Add note");
  await text("Customer is on the legacy plan.");
  await shot("2-ticket");
  console.log("✓ internal note added");

  await page.goto(`${APP}/`, { waitUntil: "networkidle0" });
  await page.select("select[aria-label='Demo user']", "globex-agent");
  await text("No tickets here");
  await page.goto(`${APP}/tickets/${ref}`, { waitUntil: "networkidle0" });
  await text("not in your company");
  await shot("3-other-tenant");
  console.log("✓ Globex agent can't see Acme's ticket");

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log("\nE2E passed");
} catch (err) {
  failed = true;
  console.error(`\n✘ ${err instanceof Error ? err.stack : err}`);
  for (const c of children) console.error(`\n---- ${c.logName} log (tail) ----\n${c.log().slice(-4000)}`);
} finally {
  await browser?.close();
  for (const c of children) c.p.kill();
  process.exit(failed ? 1 : 0);
}
