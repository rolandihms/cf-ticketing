import { introspectWorkflow, type WorkflowInstanceModifier } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { D1Dialect, D1Repo } from "@rolandihms/helpdesk-db";
import { Kysely } from "kysely";
import { inboundMessage, rawEmail } from "./helpers";

const SUPPORT = "support@acme.test";
const CUSTOMER = "jane@cust.example";

async function deliver(raw: string, from = CUSTOMER, to = SUPPORT, overrides: Partial<Env> = {}) {
  const msg = inboundMessage(from, to, raw);
  await worker.email(msg, { ...env, ...overrides });
  return msg;
}

const LLM_QUESTION = {
  classifier: "llm",
  result: { category: "question", confidence: 0.82, codeRelated: false, priority: "low", summary: "Customer asks for help" },
  meta: { provider: "workers-ai", model: "test-model" },
  durationMs: 5,
};

/** Runs fn and waits for the Workflow instances it created. Workers AI is mocked (tests never call it). */
async function runOne(fn: () => Promise<unknown>, mock: (m: WorkflowInstanceModifier) => Promise<void> = (m) => m.mockStepResult({ name: "classify:llm" }, LLM_QUESTION)) {
  await using introspector = await introspectWorkflow(env.INBOUND_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableRetryDelays();
    await mock(m);
  });
  await fn();
  const instances = await introspector.get();
  const outputs = [];
  for (const i of instances) {
    await i.waitForStatus("complete");
    outputs.push(await i.getOutput());
  }
  return outputs as { ticketRef: string; created: boolean; threadedBy: string; acked: boolean; category?: string }[];
}

const repo = () => new D1Repo(env.DB, new Kysely({ dialect: new D1Dialect(env.DB) }));

/**
 * Fake GitHub API + webhook receiver behind globalThis.fetch. This works because the Workers Vitest
 * integration runs the Workflow in the same isolate as the tests.
 */
const outbound: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
beforeEach(() => {
  outbound.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const body = req.method === "GET" ? "" : await req.text();
    outbound.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (req.url === "https://api.github.com/repos/acme/app") return json({ private: true, full_name: "acme/app" });
    if (req.url === "https://api.github.com/repos/acme/app/labels") return json({ message: "already_exists" }, 422);
    if (req.url === "https://api.github.com/user") return json({ login: "helpdesk-bot" });
    if (req.url.startsWith("https://api.github.com/repos/acme/app/issues?")) return json([]);
    if (req.url === "https://api.github.com/repos/acme/app/issues" && req.method === "POST")
      return json({ number: 77, html_url: "https://github.com/acme/app/issues/77", title: JSON.parse(body).title, labels: [{ name: "from-helpdesk" }] }, 201);
    if (req.url === "https://hooks.test/helpdesk") return new Response("ok");
    throw new Error(`unexpected outbound request: ${req.method} ${req.url}`);
  });
});
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  for (const t of ["ticket_links", "ticket_classifications", "attachments", "ticket_events", "messages", "tickets", "contacts", "counters", "mailboxes"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await repo().createMailbox({ address: SUPPORT, name: "Acme Support", refPrefix: "ACME" });
});

describe("inbound email → ticket", () => {
  it("creates a ticket with a sequential ref and acknowledges it", async () => {
    const [a] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Printer on fire" })));
    const [b] = await runOne(() => deliver(rawEmail({ from: "bob@cust.example", to: SUPPORT, subject: "Second" }), "bob@cust.example"));
    expect(a).toMatchObject({ ticketRef: "ACME-000001", created: true, acked: true });
    expect(b).toMatchObject({ ticketRef: "ACME-000002", created: true });

    const t = await repo().findTicketByRef("ACME-000001");
    expect(t?.subject).toBe("Printer on fire");
    const msgs = await repo().db.selectFrom("messages").selectAll().where("ticket_id", "=", t!.id).orderBy("created_at").execute();
    expect(msgs.map((m) => `${m.direction}:${m.kind}`)).toEqual(["inbound:customer", "outbound:ack"]);
    expect(msgs[1]!.subject).toBe("[ACME-000001] Re: Printer on fire");
  });

  it("threads a reply to our ack via In-Reply-To", async () => {
    await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Help" })));
    const ack = await repo().db.selectFrom("messages").select("message_id_hdr").where("kind", "=", "ack").executeTakeFirstOrThrow();
    const [r] = await runOne(() =>
      deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Re: whatever", headers: { "In-Reply-To": ack.message_id_hdr!, References: ack.message_id_hdr! } })),
    );
    expect(r).toMatchObject({ ticketRef: "ACME-000001", created: false, threadedBy: "message-id", acked: false });
  });

  it("threads by subject ref only for the requester", async () => {
    await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Help" })));
    const [mine] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Re: [ACME-000001] Help" })));
    expect(mine).toMatchObject({ ticketRef: "ACME-000001", threadedBy: "subject-ref" });
    const [stranger] = await runOne(() =>
      deliver(rawEmail({ from: "mallory@evil.example", to: SUPPORT, subject: "Re: [ACME-000001] Help" }), "mallory@evil.example"),
    );
    expect(stranger).toMatchObject({ ticketRef: "ACME-000002", created: true });
  });

  it("ignores redelivery of the same message", async () => {
    const raw = rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Dup", messageId: "<dup-1@cust.example>" });
    const outputs = await runOne(async () => {
      await deliver(raw);
      await deliver(raw);
    });
    expect(outputs).toHaveLength(1);
    const count = await repo().db.selectFrom("tickets").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it("stores automated mail but never auto-replies", async () => {
    const [r] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Out of office", headers: { "Auto-Submitted": "auto-replied" } })));
    expect(r).toMatchObject({ created: true, acked: false });
  });

  it("rejects unknown recipients and drops our own outbound loops", async () => {
    const unknown = await deliver(rawEmail({ from: CUSTOMER, to: "nobody@acme.test", subject: "x" }), CUSTOMER, "nobody@acme.test");
    expect(unknown.setReject).toHaveBeenCalledWith("Unknown recipient");
    const outputs = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "loop", headers: { "X-Helpdesk-Ticket": "ACME-000009" } })));
    expect(outputs).toHaveLength(0);
  });
});

describe("classification", () => {
  const detail = async (ref: string) => (await repo().getTicketDetail(ref))!;

  it("classifies new tickets with the LLM when rules abstain", async () => {
    const [r] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "How do I export?", body: "Where is the export button?" })));
    expect(r).toMatchObject({ category: "question" });
    const d = await detail(r!.ticketRef);
    expect(d.ticket).toMatchObject({ category: "question", categoryConfidence: 0.82, codeRelated: false, summary: "Customer asks for help", priority: "low" });
    expect(d.classifications.map((c) => [c.classifier, Number(c.accepted)])).toEqual([["rules", 0], ["llm", 1]]);
    expect(d.events.map((e) => e.type)).toContain("ticket.classified");
  });

  it("short-circuits on a confident rule (no LLM call)", async () => {
    const [r] = await runOne(() =>
      deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Crash", body: "Uncaught TypeError: x is undefined\n    at render (app.js:12:4)" })),
    );
    const d = await detail(r!.ticketRef);
    expect(d.ticket).toMatchObject({ category: "bug", codeRelated: true, priority: "high" });
    expect(d.classifications.map((c) => c.classifier)).toEqual(["rules"]);
  });

  it("falls back to 'other' when the LLM keeps failing, without failing the ticket", async () => {
    const [r] = await runOne(
      () => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Hmm", body: "Something about something" })),
      (m) => m.mockStepError({ name: "classify:llm" }, new Error("JSON Mode couldn't be met")),
    );
    expect(r).toMatchObject({ created: true, acked: true, category: "other" });
    const d = await detail(r!.ticketRef);
    expect(d.classifications.find((c) => c.classifier === "llm")?.error_text).toMatch(/JSON Mode/);
  });

  it("does not reclassify customer replies by default", async () => {
    await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Help", body: "q" })));
    const [reply] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Re: [ACME-000001] Help", body: "more" })));
    expect(reply).toMatchObject({ created: false });
    expect(reply!.category).toBeUndefined();
  });
});

describe("integrations: GitHub issues + webhooks", () => {
  it("opens a GitHub issue for a code bug and notifies the webhook receiver", async () => {
    const [r] = await runOne(() =>
      deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Crash", body: "Uncaught TypeError: x is undefined\n    at render (app.js:12:4)" })),
    );
    const post = outbound.find((o) => o.method === "POST" && o.url.endsWith("/repos/acme/app/issues"))!;
    expect(post).toBeDefined();
    expect(JSON.parse(post.body).title).toMatch(/^\[ACME-000001\] /);
    expect(post.headers.authorization).toBe("Bearer test-gh-token");

    const hooks = outbound.filter((o) => o.url === "https://hooks.test/helpdesk");
    expect(hooks.map((h) => h.headers["x-helpdesk-event"])).toEqual(["ticket.classified", "github.issue.created"]);
    const created = JSON.parse(hooks[1]!.body);
    expect(created).toMatchObject({ type: "github.issue.created", ticket: { ref: "ACME-000001", category: "bug" }, data: { number: 77, repo: "acme/app" } });
    expect(hooks[1]!.headers["x-helpdesk-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const d = (await repo().getTicketDetail(r!.ticketRef))!;
    expect(await repo().getLink(d.ticket.id, "github")).toMatchObject({ externalId: "acme/app#77", url: "https://github.com/acme/app/issues/77" });
    expect(d.events.map((e) => e.type)).toContain("github.issue.created");
  });

  it("does not open issues for non-bug tickets (webhook still gets ticket.classified)", async () => {
    await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "How do I export?", body: "Where is the button?" })));
    expect(outbound.some((o) => o.url.includes("api.github.com"))).toBe(false);
    expect(outbound.filter((o) => o.url === "https://hooks.test/helpdesk").map((h) => h.headers["x-helpdesk-event"])).toEqual(["ticket.classified"]);
  });
});

describe("ACK_MODE=reply (free plan)", () => {
  it("acknowledges from the handler with message.reply() and the Workflow skips its ack", async () => {
    let msg!: Awaited<ReturnType<typeof deliver>>;
    const [r] = await runOne(async () => {
      msg = await deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Free plan" }), CUSTOMER, SUPPORT, { ACK_MODE: "reply" });
    });
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ticketRef: "ACME-000001", created: true, acked: true, threadedBy: "duplicate" });
    const acks = await repo().db.selectFrom("messages").select("id").where("kind", "=", "ack").execute();
    expect(acks).toHaveLength(1);
  });
});

describe("api", () => {
  it("requires a token and returns ticket detail", async () => {
    await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "API" })));
    const denied = await worker.fetch(new Request("http://x/api/tickets"), env, {} as ExecutionContext);
    expect(denied.status).toBe(401);
    const res = await worker.fetch(
      new Request("http://x/api/tickets/ACME-000001", { headers: { authorization: "Bearer test-token" } }),
      env,
      {} as ExecutionContext,
    );
    const body = await res.json<{ ticket: { ref: string }; messages: unknown[] }>();
    expect(body.ticket.ref).toBe("ACME-000001");
    expect(body.messages).toHaveLength(2);
  });
});
