import { D1Dialect, D1Repo } from "@cf-helpdesk/db";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { _clearAccessCertCache } from "@cf-helpdesk/worker";
import { inboundMessage, rawEmail } from "./helpers";

const repo = () => new D1Repo(env.DB, new Kysely({ dialect: new D1Dialect(env.DB) }));
const SUPPORT = "support@acme.test";
const CUSTOMER = "jane@cust.example";
const ISS = "https://acme-test.cloudflareaccess.com";

// ---- Access JWT minting (real RS256, verified by the Worker against stubbed certs) ----
const b64url = (b: ArrayBuffer | Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let keyPair: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

async function accessJwt(claims: Record<string, unknown>, opts: { key?: CryptoKey; kid?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "k1", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ aud: ["test-aud"], iss: ISS, exp: now + 300, iat: now, sub: "u1", ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; jwt?: string; body?: unknown; headers?: Record<string, string>; env?: Partial<Env>; rawBody?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.jwt) headers["cf-access-jwt-assertion"] = opts.jwt;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, opts.headers);
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const res = await worker.fetch(new Request(`https://hd.test${path}`, { method, headers, body }), { ...env, ...opts.env }, {} as ExecutionContext);
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
const admin = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(method, path, { token: "test-token", body, headers });

beforeEach(async () => {
  for (const t of ["ticket_links", "ticket_classifications", "attachments", "ticket_events", "messages", "tickets", "contacts", "counters", "agents", "mailboxes"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  _clearAccessCertCache();
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey), kid: "k1" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new Request(input as RequestInfo).url;
    if (url === `${ISS}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${url}`);
  });
  await repo().createMailbox({ address: SUPPORT, name: "Acme Support", refPrefix: "ACME" });
});
afterEach(() => vi.restoreAllMocks());

async function newTicket(subject = "Printer on fire") {
  const r = repo();
  const mailbox = (await r.getMailboxByAddress(SUPPORT))!;
  const c = await r.upsertContact(CUSTOMER, "Jane");
  const key = crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
  return (await r.createTicketWithFirstMessage({
    mailbox, requesterId: c.id, subject, sourceIngestKey: key, attachments: [],
    message: {
      direction: "inbound", kind: "customer", ingest_key: key, message_id_hdr: `<${key.slice(0, 8)}@cust.example>`, provider_msg_id: null,
      in_reply_to: null, from_addr: CUSTOMER, to_json: "[]", cc_json: null, subject, text_preview: "help", text_r2_key: null,
      html_r2_key: null, raw_r2_key: null, auth_json: null, author_agent_id: null,
    },
  })).ticket;
}

describe("authentication", () => {
  it("rejects missing or wrong credentials", async () => {
    expect((await call("GET", "/api/me")).status).toBe(401);
    expect((await call("GET", "/api/me", { token: "nope" })).status).toBe(401);
  });

  it("treats the API token as an admin service", async () => {
    expect((await admin("GET", "/api/me")).json).toEqual({ kind: "service", role: "admin", actor: "api" });
  });

  it("accepts a valid Cloudflare Access JWT for an active agent only", async () => {
    const ann = (await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann", role: "agent" })).json;
    const me = await call("GET", "/api/me", { jwt: await accessJwt({ email: "Ann@acme.test" }) });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ kind: "agent", role: "agent", actor: `agent:${ann.id}` });

    expect((await call("GET", "/api/me", { jwt: await accessJwt({ email: "stranger@acme.test" }) })).status).toBe(403);
    await admin("PATCH", `/api/agents/${ann.id}`, { active: false });
    expect((await call("GET", "/api/me", { jwt: await accessJwt({ email: "ann@acme.test" }) })).status).toBe(403);
  });

  it("rejects tampered, expired, wrong-audience, wrong-issuer and foreign-key tokens", async () => {
    await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann" });
    const good = await accessJwt({ email: "ann@acme.test" });
    const [h, p, s] = good.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ ...JSON.parse(atob(p!.replace(/-/g, "+").replace(/_/g, "/"))), email: "boss@acme.test" }))}.${s}`;
    const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    for (const jwt of [
      forged,
      await accessJwt({ email: "ann@acme.test", exp: Math.floor(Date.now() / 1000) - 3600 }),
      await accessJwt({ email: "ann@acme.test", aud: ["other-app"] }),
      await accessJwt({ email: "ann@acme.test", iss: "https://evil.cloudflareaccess.com" }),
      await accessJwt({ email: "ann@acme.test" }, { key: other.privateKey }),
      "not.a.jwt",
    ]) {
      expect((await call("GET", "/api/me", { jwt })).status).toBe(401);
    }
  });
});

describe("CSRF and input hardening", () => {
  it("rejects non-JSON bodies (form posts) and cross-site browser requests for Access logins", async () => {
    await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann" });
    const t = await newTicket();
    const jwt = await accessJwt({ email: "ann@acme.test" });
    const form = await call("POST", `/api/tickets/${t.ref}/notes`, { jwt, rawBody: '{"text":"x","y":"=1"}', headers: { "content-type": "text/plain" } });
    expect(form.status).toBe(415);
    const crossSite = await call("POST", `/api/tickets/${t.ref}/notes`, { jwt, body: { text: "x" }, headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    const otherOrigin = await call("POST", `/api/tickets/${t.ref}/notes`, { jwt, body: { text: "x" }, headers: { origin: "https://evil.example" } });
    expect(otherOrigin.status).toBe(403);
    const sameSite = await call("POST", `/api/tickets/${t.ref}/notes`, { jwt, body: { text: "x" }, headers: { "sec-fetch-site": "same-origin" } });
    expect(sameSite.status).toBe(201);
  });

  it("answers 503 (not 500) when Access certificates can't be fetched, and rate-limits forced refetches", async () => {
    await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann" });
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("down", { status: 502 }));
    expect((await call("GET", "/api/me", { jwt: await accessJwt({ email: "ann@acme.test" }) })).status).toBe(503);

    _clearAccessCertCache();
    let fetches = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async () => (fetches++, Response.json({ keys: [jwk] })));
    for (let i = 0; i < 5; i++) {
      expect((await call("GET", "/api/me", { jwt: await accessJwt({ email: "ann@acme.test" }, { kid: `unknown-${i}` }) })).status).toBe(401);
    }
    expect(fetches).toBe(1); // unknown kids don't trigger a fetch per request
  });
});

describe("agents and roles", () => {
  it("never leaves the help desk without an active admin", async () => {
    const boss = (await admin("POST", "/api/agents", { email: "boss@acme.test", name: "Boss", role: "admin" })).json;
    expect((await admin("PATCH", `/api/agents/${boss.id}`, { active: false })).status).toBe(409);
    const second = (await admin("POST", "/api/agents", { email: "deputy@acme.test", name: "Deputy", role: "admin" })).json;
    expect((await admin("PATCH", `/api/agents/${boss.id}`, { active: false })).status).toBe(200);
    expect((await admin("PATCH", `/api/agents/${second.id}`, { role: "agent" })).status).toBe(409);
  });

  it("only admins manage agents and mailboxes; nobody can demote themselves", async () => {
    const boss = (await admin("POST", "/api/agents", { email: "boss@acme.test", name: "Boss", role: "admin" })).json;
    await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann" });
    const annJwt = await accessJwt({ email: "ann@acme.test" });
    expect((await call("POST", "/api/agents", { jwt: annJwt, body: { email: "x@acme.test", name: "X" } })).status).toBe(403);
    expect((await call("POST", "/api/mailboxes", { jwt: annJwt, body: { address: "a@b.test", name: "A", refPrefix: "AB" } })).status).toBe(403);
    expect((await call("GET", "/api/agents", { jwt: annJwt })).json.agents).toHaveLength(2);

    const bossJwt = await accessJwt({ email: "boss@acme.test" });
    expect((await call("PATCH", `/api/agents/${boss.id}`, { jwt: bossJwt, body: { role: "agent" } })).status).toBe(409);
    expect((await admin("POST", "/api/agents", { email: "bad", name: "X" })).status).toBe(400);
  });
});

describe("ticket workflow", () => {
  it("updates status, priority and assignee (incl. 'me'), validating input", async () => {
    const ann = (await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann" })).json;
    const t = await newTicket();
    const jwt = await accessJwt({ email: "ann@acme.test" });
    const res = await call("PATCH", `/api/tickets/${t.ref}`, { jwt, body: { status: "open", priority: "urgent", assignee: "me" } });
    expect(res.json).toMatchObject({ status: "open", priority: "urgent", assigneeId: ann.id });

    expect((await call("PATCH", `/api/tickets/${t.ref}`, { jwt, body: { status: "done" } })).status).toBe(400);
    expect((await call("PATCH", `/api/tickets/${t.ref}`, { jwt, body: { assignee: "01NOPE" } })).status).toBe(400);
    expect((await call("PATCH", "/api/tickets/ACME-999999", { jwt, body: { status: "open" } })).status).toBe(404);

    const events = (await admin("GET", `/api/tickets/${t.ref}`)).json.events.map((e: any) => [e.type, e.actor]);
    expect(events).toContainEqual(["ticket.assigned", `agent:${ann.id}`]);
  });

  it("filters the ticket list (status, assignee=me|unassigned, q) and paginates", async () => {
    await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann" });
    const jwt = await accessJwt({ email: "ann@acme.test" });
    const a = await newTicket("Printer jam");
    await newTicket("Billing question");
    await call("PATCH", `/api/tickets/${a.ref}`, { jwt, body: { assignee: "me", status: "open" } });
    const refs = async (qs: string) => (await call("GET", `/api/tickets?${qs}`, { jwt })).json.tickets.map((t: any) => t.ref);
    expect(await refs("assignee=me")).toEqual([a.ref]);
    expect(await refs("assignee=unassigned")).toEqual(["ACME-000002"]);
    expect(await refs("status=new,open&q=printer")).toEqual([a.ref]);
    const page = (await call("GET", "/api/tickets?limit=1", { jwt })).json;
    expect(page.nextCursor).toBeTruthy();
    expect((await call("GET", `/api/tickets?limit=1&cursor=${page.nextCursor}`, { jwt })).json.tickets).toHaveLength(1);
    expect((await call("GET", "/api/tickets?status=bogus", { jwt })).status).toBe(400);
  });

  it("adds internal notes (never emailed) with full text in R2", async () => {
    const t = await newTicket();
    const long = "Customer is on the legacy plan. ".repeat(40);
    const note = (await admin("POST", `/api/tickets/${t.ref}/notes`, { text: long })).json;
    expect(note).toMatchObject({ direction: "note", kind: "note" });
    const res = await worker.fetch(new Request(`https://hd.test/api/messages/${note.id}/text`, { headers: { authorization: "Bearer test-token" } }), env, {} as ExecutionContext);
    expect(await res.text()).toBe(long);
  });
});

describe("agent replies", () => {
  it("emails the customer threaded on their message, sets pending, and is idempotent", async () => {
    const ann = (await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann" })).json;
    const t = await newTicket();
    const jwt = await accessJwt({ email: "ann@acme.test" });
    const headers = { "idempotency-key": "reply-1" };
    const first = await call("POST", `/api/tickets/${t.ref}/replies`, { jwt, headers, body: { text: "Have you tried turning it off and on?" } });
    expect(first.status).toBe(201);
    expect(first.json.ticket.status).toBe("pending");
    expect(first.json.message).toMatchObject({ direction: "outbound", kind: "agent_reply", author_agent_id: ann.id, subject: `[${t.ref}] Re: Printer on fire` });
    expect(first.json.message.in_reply_to).toMatch(/@cust\.example>$/);
    expect(first.json.message.provider_msg_id).toBeTruthy();

    const retry = await call("POST", `/api/tickets/${t.ref}/replies`, { jwt, headers, body: { text: "Have you tried turning it off and on?" } });
    expect(retry.status).toBe(200);
    expect(retry.json.message.id).toBe(first.json.message.id);
    const outbound = (await admin("GET", `/api/tickets/${t.ref}`)).json.messages.filter((m: any) => m.kind === "agent_reply");
    expect(outbound).toHaveLength(1);
  });

  it("sends at most once for concurrent requests with the same idempotency key", async () => {
    const t = await newTicket();
    let sends = 0;
    const EMAIL = { send: async () => (sends++, await new Promise((r) => setTimeout(r, 20)), { messageId: "<p1@acme.test>" }) } as unknown as SendEmail;
    const req = () => call("POST", `/api/tickets/${t.ref}/replies`, { token: "test-token", env: { EMAIL }, headers: { "idempotency-key": "k1" }, body: { text: "Hi" } });
    const [a, b] = await Promise.all([req(), req()]);
    expect(sends).toBe(1);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.json.message.id).toBe(b.json.message.id);
  });

  it("on send failure returns 502 and records nothing, so a retry is safe", async () => {
    const t = await newTicket();
    const EMAIL = { send: async () => { throw new Error("E_DAILY_LIMIT_EXCEEDED"); } } as unknown as SendEmail;
    const res = await call("POST", `/api/tickets/${t.ref}/replies`, { token: "test-token", env: { EMAIL }, headers: { "idempotency-key": "k2" }, body: { text: "Hi" } });
    expect(res.status).toBe(502);
    expect(res.json.error).not.toMatch(/E_DAILY/); // provider details are logged, not returned
    const d = (await admin("GET", `/api/tickets/${t.ref}`)).json;
    expect(d.messages.filter((m: any) => m.kind === "agent_reply")).toHaveLength(0);
    expect(d.ticket.status).toBe("new");
    const retry = await call("POST", `/api/tickets/${t.ref}/replies`, { token: "test-token", headers: { "idempotency-key": "k2" }, body: { text: "Hi" } });
    expect(retry.status).toBe(201);
  });

  it("a customer answer to the agent's reply threads back and reopens the ticket", async () => {
    await admin("POST", "/api/agents", { email: "ann@acme.test", name: "Ann" });
    const t = await newTicket();
    const reply = (await call("POST", `/api/tickets/${t.ref}/replies`, { jwt: await accessJwt({ email: "ann@acme.test" }), body: { text: "Try again?" } })).json;

    await using introspector = await introspectWorkflow(env.INBOUND_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepResult({ name: "classify:llm" }, { classifier: "llm", result: null, durationMs: 1 });
    });
    const raw = rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Re: whatever", body: "Still broken", headers: { "In-Reply-To": reply.message.provider_msg_id } });
    await worker.email(inboundMessage(CUSTOMER, SUPPORT, raw), env);
    for (const i of await introspector.get()) await i.waitForStatus("complete");

    const d = (await admin("GET", `/api/tickets/${t.ref}`)).json;
    expect(d.ticket.status).toBe("open");
    expect(d.messages.map((m: any) => m.kind)).toEqual(["customer", "agent_reply", "customer"]);
  });
});
