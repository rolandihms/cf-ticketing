import { D1Dialect, D1Repo } from "@rolandihms/helpdesk-db";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { _clearAccessCertCache } from "@rolandihms/helpdesk-worker";
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

/** Webhook deliveries received by the fake receiver (agent-action events go through the Workflow). */
const hooks: { type: string; body: any }[] = [];

// ---- Trusted principal (a host app calling over a service binding) ----
const TRUSTED = { TRUSTED_PRINCIPAL: "on", HELPDESK_SERVICE_KEY: "svc-key" } as Partial<Env>;
const host = (method: string, path: string, who: Record<string, unknown>, o: { body?: unknown; key?: string } = {}) =>
  call(method, path, {
    env: TRUSTED,
    body: o.body,
    headers: { "x-helpdesk-service-key": o.key ?? "svc-key", "x-helpdesk-principal": JSON.stringify(who) },
  });
const kim = { externalId: "user_1", email: "kim@host.test", name: "Kim", role: "agent", partition: "company:1" };

beforeEach(async () => {
  for (const t of ["ticket_links", "ticket_classifications", "attachments", "ticket_events", "messages", "tickets", "contacts", "counters", "agent_partitions", "agents", "mailboxes"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  _clearAccessCertCache();
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey), kid: "k1" };
  hooks.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url === `${ISS}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (req.url === "https://hooks.test/helpdesk") {
      hooks.push({ type: req.headers.get("x-helpdesk-event")!, body: JSON.parse(await req.text()) });
      return new Response("ok");
    }
    throw new Error(`unexpected fetch ${req.url}`);
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
    expect((await admin("GET", "/api/me")).json).toEqual({ kind: "service", role: "admin", actor: "api", partition: null, via: "token" });
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

describe("trusted principal (embedding)", () => {
  it("is off unless enabled, and needs the service key", async () => {
    const off = await call("GET", "/api/me", { headers: { "x-helpdesk-service-key": "svc-key", "x-helpdesk-principal": JSON.stringify(kim) } });
    expect(off.status).toBe(401);
    expect((await host("GET", "/api/me", kim, { key: "wrong" })).status).toBe(401);
    // The key is checked before the identity header is even parsed.
    expect((await host("GET", "/api/me", { nonsense: true }, { key: "wrong" })).status).toBe(401);
  });

  it("validates the identity; partition must be given explicitly", async () => {
    const { partition: _p, ...noPartition } = kim;
    expect((await host("GET", "/api/me", noPartition)).json.error).toMatch(/partition is required/);
    expect((await host("GET", "/api/me", { ...kim, role: "owner" })).status).toBe(400);
    expect((await host("GET", "/api/me", { ...kim, email: "nope" })).status).toBe(400);
  });

  it("provisions the agent on first use and re-syncs role and name from the host", async () => {
    const me = await host("GET", "/api/me", kim);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ kind: "agent", role: "agent", via: "trusted", partition: "company:1", agent: { externalId: "user_1", email: "kim@host.test" } });
    const again = await host("GET", "/api/me", { ...kim, role: "admin", name: "Kim Admin" });
    expect(again.json).toMatchObject({ role: "admin", agent: { id: me.json.agent.id, name: "Kim Admin", role: "admin" } });
    // Partition comes from the request, not the agent: the same user can work another company.
    expect((await host("GET", "/api/me", { ...kim, partition: "company:2" })).json.partition).toBe("company:2");
  });
});

describe("partitions", () => {
  async function setup() {
    await admin("POST", "/api/mailboxes", { address: "help@one.test", name: "One", refPrefix: "ONE", partition: "company:1" });
    await admin("POST", "/api/mailboxes", { address: "help@two.test", name: "Two", refPrefix: "TWO", partition: "company:2" });
    const r = repo();
    const mk = async (address: string) => {
      const mailbox = (await r.getMailboxByAddress(address))!;
      const c = await r.upsertContact(CUSTOMER, "Jane");
      const key = crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
      return (await r.createTicketWithFirstMessage({
        mailbox, requesterId: c.id, subject: "Leaking tap", sourceIngestKey: key,
        attachments: [],
        message: {
          direction: "inbound", kind: "customer", ingest_key: key, message_id_hdr: `<${key.slice(0, 8)}@cust.example>`, provider_msg_id: null,
          in_reply_to: null, from_addr: CUSTOMER, to_json: "[]", cc_json: null, subject: "Leaking tap", text_preview: "drip", text_r2_key: null,
          html_r2_key: null, raw_r2_key: null, auth_json: null, author_agent_id: null,
        },
      })).ticket;
    };
    const one = await mk("help@one.test");
    const two = await mk("help@two.test");
    return { one, two };
  }

  it("restricts a partitioned caller to its own mailboxes, tickets and messages", async () => {
    const { one, two } = await setup();
    const list = (await host("GET", "/api/tickets", kim)).json.tickets.map((t: any) => t.ref);
    expect(list).toEqual([one.ref]);
    expect((await host("GET", "/api/mailboxes", kim)).json.mailboxes.map((m: any) => m.address)).toEqual(["help@one.test"]);
    expect((await host("GET", `/api/tickets/${one.ref}`, kim)).status).toBe(200);
    for (const [method, path, body] of [
      ["GET", `/api/tickets/${two.ref}`],
      ["PATCH", `/api/tickets/${two.ref}`, { status: "open" }],
      ["POST", `/api/tickets/${two.ref}/notes`, { text: "x" }],
      ["POST", `/api/tickets/${two.ref}/replies`, { text: "x" }],
    ] as const) {
      expect((await host(method, path, kim, { body })).status, `${method} ${path}`).toBe(404);
    }
    const otherMsg = (await admin("GET", `/api/tickets/${two.ref}`)).json.messages[0].id;
    expect((await host("GET", `/api/messages/${otherMsg}/text`, kim)).status).toBe(404);
    // Unrestricted callers see everything and may narrow to one partition.
    expect((await admin("GET", "/api/tickets")).json.tickets).toHaveLength(2);
    expect((await admin("GET", "/api/tickets?partition=company:2")).json.tickets.map((t: any) => t.ref)).toEqual([two.ref]);
  });

  it("only assigns agents who can see the ticket; restricted admins create agents in their partition", async () => {
    const { one } = await setup();
    const outsider = (await admin("POST", "/api/agents", { email: "out@two.test", name: "Out", partition: "company:2" })).json;
    const global = (await admin("POST", "/api/agents", { email: "staff@acme.test", name: "Staff" })).json;
    expect((await host("PATCH", `/api/tickets/${one.ref}`, kim, { body: { assignee: outsider.id } })).status).toBe(400);
    expect((await host("PATCH", `/api/tickets/${one.ref}`, kim, { body: { assignee: global.id } })).json.assigneeId).toBe(global.id);

    const boss = { ...kim, externalId: "user_2", email: "boss@host.test", role: "admin" };
    const made = (await host("POST", "/api/agents", boss, { body: { email: "new@one.test", name: "New", partition: null } })).json;
    expect(made.partition).toBe("company:1");
    expect((await host("PATCH", `/api/agents/${global.id}`, boss, { body: { name: "Hijack" } })).status).toBe(404);
    expect((await host("PATCH", `/api/agents/${made.id}`, boss, { body: { partition: null } })).status).toBe(403);
    expect((await host("GET", "/api/agents", boss)).json.agents.map((a: any) => a.email)).not.toContain("out@two.test");
  });
});

describe("host-provisioned agents across tenants", () => {
  it("are listed and assignable only in partitions the host sent them with", async () => {
    await admin("POST", "/api/mailboxes", { address: "help@one.test", name: "One", refPrefix: "ONE", partition: "company:1" });
    const r = repo();
    const mailbox = (await r.getMailboxByAddress("help@one.test"))!;
    const c = await r.upsertContact(CUSTOMER, null);
    const key = "e".repeat(64);
    const { ticket } = await r.createTicketWithFirstMessage({
      mailbox, requesterId: c.id, subject: "s", sourceIngestKey: key, attachments: [],
      message: {
        direction: "inbound", kind: "customer", ingest_key: key, message_id_hdr: null, provider_msg_id: null, in_reply_to: null, from_addr: CUSTOMER,
        to_json: "[]", cc_json: null, subject: "s", text_preview: "", text_r2_key: null, html_r2_key: null, raw_r2_key: null, auth_json: null, author_agent_id: null,
      },
    });
    const lee = { externalId: "user_2", email: "lee@host.test", name: "Lee", role: "agent", partition: "company:2" };
    const leeId = (await host("GET", "/api/me", lee)).json.agent.id;
    const kimId = (await host("GET", "/api/me", kim)).json.agent.id;
    const staffId = (await host("GET", "/api/me", { ...kim, externalId: "staff", email: "staff@host.test", role: "admin", partition: null })).json.agent.id;

    const emails = (await host("GET", "/api/agents", kim)).json.agents.map((a: any) => a.email);
    expect(emails).toContain("kim@host.test");
    expect(emails).toContain("staff@host.test");
    expect(emails).not.toContain("lee@host.test");

    expect((await host("PATCH", `/api/tickets/${ticket.ref}`, kim, { body: { assignee: leeId } })).status).toBe(400);
    expect((await host("PATCH", `/api/tickets/${ticket.ref}`, kim, { body: { assignee: staffId } })).status).toBe(200);
    expect((await host("PATCH", `/api/tickets/${ticket.ref}`, kim, { body: { assignee: kimId } })).json.assigneeId).toBe(kimId);
  });

  it("can't sign in through Cloudflare Access (their partition comes from the host)", async () => {
    await host("GET", "/api/me", kim);
    expect((await call("GET", "/api/me", { jwt: await accessJwt({ email: "kim@host.test" }) })).status).toBe(403);
  });

  it("an email clash on re-sync is a 409, not a 500", async () => {
    await admin("POST", "/api/agents", { email: "taken@host.test", name: "Taken" });
    await host("GET", "/api/me", kim);
    expect((await host("GET", "/api/me", { ...kim, email: "taken@host.test" })).status).toBe(409);
  });

  it("creating an agent or mailbox that exists elsewhere is a conflict, without details", async () => {
    await admin("POST", "/api/agents", { email: "other@two.test", name: "Other", partition: "company:2" });
    const boss = { ...kim, externalId: "boss", email: "boss@host.test", role: "admin" };
    const res = await host("POST", "/api/agents", boss, { body: { email: "other@two.test", name: "X" } });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).not.toContain("company:2");
    const mine = await host("POST", "/api/agents", boss, { body: { email: "new@one.test", name: "New" } });
    expect(mine.status).toBe(201);
    expect((await host("POST", "/api/agents", boss, { body: { email: "new@one.test", name: "New" } })).status).toBe(200);

    await admin("POST", "/api/mailboxes", { address: "help@two.test", name: "Two", refPrefix: "TWO", partition: "company:2" });
    expect((await admin("POST", "/api/mailboxes", { address: "help@two.test", name: "Two", refPrefix: "TWO", partition: "company:3" })).status).toBe(409);
  });

  it("only an unrestricted admin adds mailboxes, with plain addresses and header-safe names", async () => {
    const boss = { ...kim, externalId: "boss", email: "boss@host.test", role: "admin" };
    expect((await host("POST", "/api/mailboxes", boss, { body: { address: "claim@one.test", name: "One", refPrefix: "ONE" } })).status).toBe(403);

    const bad = [
      { address: "a@b", name: "A", refPrefix: "AB" },
      { address: "x\r\nBcc: v@evil.test@one.test", name: "A", refPrefix: "AB" },
      { address: "<a@one.test>", name: "A", refPrefix: "AB" },
      { address: `${"a".repeat(250)}@one.test`, name: "A", refPrefix: "AB" },
      { address: "a@one.test", name: "A\r\nBcc: v@evil.test", refPrefix: "AB" },
      { address: "a@one.test", name: "A", fromName: 42, refPrefix: "AB" },
      { address: "a@one.test", name: "A", fromName: "x".repeat(256), refPrefix: "AB" },
      { address: "a@one.test", name: "A", refPrefix: "A-B" },
    ];
    for (const b of bad) expect((await admin("POST", "/api/mailboxes", b)).status, JSON.stringify(b)).toBe(400);

    const ok = await admin("POST", "/api/mailboxes", { address: "Help@One.Test", name: "One", fromName: "One Support", refPrefix: "ONE" });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ address: "help@one.test", fromName: "One Support" });
  });
});

describe("ticket detail", () => {
  it("returns messages without R2 keys, the ingest key or the raw auth record, plus whether DMARC proved the sender", async () => {
    const t = await newTicket();
    await env.DB.prepare("UPDATE messages SET text_r2_key = 'mail/x/body.txt', raw_r2_key = 'mail/x/raw.eml', auth_json = ? WHERE ticket_id = ?")
      .bind(JSON.stringify({ guard: [], envelopeFrom: "bounce@cust.example", dmarc: "pass", senderVerified: true }), t.id).run();
    const [m] = (await admin("GET", `/api/tickets/${t.ref}`)).json.messages;
    for (const k of ["text_r2_key", "html_r2_key", "raw_r2_key", "ingest_key", "auth_json"]) expect(m, k).not.toHaveProperty(k);
    expect(JSON.stringify(m)).not.toContain("mail/x/");
    expect(m).toMatchObject({ from_addr: CUSTOMER, direction: "inbound", sender_verified: true });

    await env.DB.prepare("UPDATE messages SET auth_json = NULL WHERE ticket_id = ?").bind(t.id).run();
    expect((await admin("GET", `/api/tickets/${t.ref}`)).json.messages[0].sender_verified).toBeNull();
  });
});

describe("attachments", () => {
  it("downloads only as an attachment, never rendered, and hides R2 keys", async () => {
    const t = await newTicket();
    const r = repo();
    const msg = (await r.getTicketDetail(t.ref))!.messages[0]!;
    await env.MAIL.put("att/evil", "<script>alert(1)</script>");
    await env.DB.prepare("INSERT INTO attachments (id, message_id, r2_key, filename, mime_type, size, created_at) VALUES ('01ATT', ?, 'att/evil', ?, 'text/html', 25, 1)")
      .bind(msg.id, 'evil"\r\nx.html').run();
    const detail = (await admin("GET", `/api/tickets/${t.ref}`)).json;
    expect(detail.attachments).toEqual([expect.objectContaining({ id: "01ATT", filename: 'evil"\r\nx.html' })]);
    expect(detail.attachments[0].r2_key).toBeUndefined();

    const res = await worker.fetch(new Request("https://hd.test/api/attachments/01ATT", { headers: { authorization: "Bearer test-token" } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="evil___x\.html"; filename\*=UTF-8''evil___x\.html$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("<script>alert(1)</script>");
    expect((await admin("GET", "/api/attachments/nope")).status).toBe(404);
  });

  it("hides attachments of other partitions", async () => {
    await admin("POST", "/api/mailboxes", { address: "help@two.test", name: "Two", refPrefix: "TWO", partition: "company:2" });
    const r = repo();
    const mailbox = (await r.getMailboxByAddress("help@two.test"))!;
    const c = await r.upsertContact(CUSTOMER, null);
    const key = "f".repeat(64);
    const { ticket } = await r.createTicketWithFirstMessage({
      mailbox, requesterId: c.id, subject: "s", sourceIngestKey: key,
      attachments: [{ r2Key: "att/two", filename: "a.pdf", mimeType: "application/pdf", size: 1 }],
      message: {
        direction: "inbound", kind: "customer", ingest_key: key, message_id_hdr: null, provider_msg_id: null, in_reply_to: null, from_addr: CUSTOMER,
        to_json: "[]", cc_json: null, subject: "s", text_preview: "", text_r2_key: null, html_r2_key: null, raw_r2_key: null, auth_json: null, author_agent_id: null,
      },
    });
    await env.MAIL.put("att/two", "x");
    const att = (await r.getTicketDetail(ticket.ref))!.attachments[0]!;
    expect((await host("GET", `/api/attachments/${att.id}`, kim)).status).toBe(404);
    const res = await call("GET", `/api/attachments/${att.id}`, { env: TRUSTED, headers: { "x-helpdesk-service-key": "svc-key", "x-helpdesk-principal": JSON.stringify({ ...kim, partition: "company:2" }) } });
    expect(res.status).toBe(200);
  });
});

describe("agent-action events", () => {
  it("delivers status, assignment and reply events to plugins (webhooks) through the Workflow", async () => {
    const t = await newTicket();
    await using introspector = await introspectWorkflow(env.INBOUND_WORKFLOW);
    await introspector.modifyAll((m) => m.disableRetryDelays());
    const who = { ...kim, partition: null };
    await host("PATCH", `/api/tickets/${t.ref}`, who, { body: { status: "open", assignee: "me" } });
    await host("POST", `/api/tickets/${t.ref}/replies`, who, { body: { text: "On it", status: "pending" } });
    await host("POST", `/api/tickets/${t.ref}/notes`, who, { body: { text: "internal" } });
    for (const i of await introspector.get()) await i.waitForStatus("complete");

    const agentId = (await host("GET", "/api/me", who)).json.agent.id;
    // ticket.note_added isn't in the endpoint's event list, so it is not delivered.
    expect(hooks.map((h) => h.type).sort()).toEqual(["ticket.assigned", "ticket.replied", "ticket.status_changed", "ticket.status_changed"].sort());
    const assigned = hooks.find((h) => h.type === "ticket.assigned")!.body;
    expect(assigned).toMatchObject({ ticket: { ref: t.ref }, data: { from: null, to: agentId, actor: `agent:${agentId}` } });
    expect(new Set(hooks.map((h) => h.body.id)).size).toBe(hooks.length); // distinct delivery ids
    expect(hooks.filter((h) => h.type === "ticket.status_changed").map((h) => h.body.data.to).sort()).toEqual(["open", "pending"]);
  });

  it("doesn't fail the action when events can't be queued", async () => {
    const t = await newTicket();
    const INBOUND_WORKFLOW = { create: async () => { throw new Error("workflows down"); } } as unknown as Workflow;
    const res = await call("PATCH", `/api/tickets/${t.ref}`, { token: "test-token", env: { INBOUND_WORKFLOW }, body: { status: "open" } });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("open");
  });
});
