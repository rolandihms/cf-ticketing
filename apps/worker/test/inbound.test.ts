import { introspectWorkflow, type WorkflowInstanceModifier } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { D1Dialect, D1Repo } from "@rolandihms/helpdesk-db";
import { Kysely } from "kysely";
import type { InboundMessageMeta, Ticket } from "@rolandihms/helpdesk-core";
import { htmlToText } from "../../../packages/worker/src/email/html-text";
import { NOTIFY_BODY_MAX, newTicketTemplate, ticketUrl } from "../../../packages/worker/src/email/templates";
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

  it("never trusts a subject ref, or acks, when DMARC doesn't prove the From address", async () => {
    await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Help" })));
    // Forged From: the victim's address with a known ref, but Email Routing says dmarc=fail (or nothing at all).
    for (const authResults of ["mx.cloudflare.net; dmarc=fail header.from=cust.example", null]) {
      const [forged] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Re: [ACME-000001] Help", authResults })));
      expect(forged).toMatchObject({ created: true, threadedBy: "new", acked: false });
    }
    // A pass the sender wrote into the message themselves sits below Email Routing's header and is ignored.
    const spoofed = rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Re: [ACME-000001] Help", authResults: "mx.cloudflare.net; dmarc=none", headers: { "Authentication-Results": "mx.cloudflare.net; dmarc=pass" } });
    const [s] = await runOne(() => deliver(spoofed));
    expect(s).toMatchObject({ created: true, acked: false });

    const first = await repo().findTicketByRef("ACME-000001");
    const msgs = await repo().db.selectFrom("messages").select(["auth_json"]).where("ticket_id", "=", first!.id).where("direction", "=", "inbound").execute();
    expect(msgs).toHaveLength(1);
    expect(JSON.parse(msgs[0]!.auth_json!)).toMatchObject({ dmarc: "pass", senderVerified: true });
  });

  it("gives HTML-only mail a text body, preview and classifier input", async () => {
    const html = "<html><head><style>p{color:red}</style></head><body><p>Hi team,</p><p>The tap&nbsp;is <b>leaking</b> &amp; dripping.<br>See <a href=\"https://x.example/p\">photo</a></p><script>alert(1)</script></body></html>";
    const [r] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Tap", body: html, contentType: "text/html; charset=utf-8" })));
    const t = await repo().findTicketByRef(r!.ticketRef);
    const m = await repo().db.selectFrom("messages").select(["text_preview", "text_r2_key", "html_r2_key"]).where("ticket_id", "=", t!.id).where("direction", "=", "inbound").executeTakeFirstOrThrow();
    expect(m.text_preview).toBe("Hi team, The tap is leaking & dripping. See photo (https://x.example/p)");
    expect(m.html_r2_key).not.toBeNull();
    expect(await (await env.MAIL.get(m.text_r2_key!))!.text()).toBe("Hi team,\n\nThe tap is leaking & dripping.\nSee photo (https://x.example/p)");
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

describe("new-ticket notifications", () => {
  const notified = async (ref: string) => {
    const t = await repo().findTicketByRef(ref);
    const events = await repo().db.selectFrom("ticket_events").selectAll().where("ticket_id", "=", t!.id).where("type", "like", "notification.%").execute();
    return events.map((e) => ({ type: e.type, data: JSON.parse(e.data_json ?? "{}") }));
  };
  beforeEach(async () => {
    const mb = (await repo().getMailboxByAddress(SUPPORT))!;
    await repo().updateMailbox(mb.id, { notifyNewTicket: ["ops@acme.test", "lead@acme.test"] });
  });

  it("emails each address once for a new ticket, including unverified senders, but not for replies", async () => {
    const [a] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Printer on fire", messageId: "<first@cust.example>" })));
    expect(await notified(a!.ticketRef)).toEqual([{ type: "notification.sent", data: { to: ["ops@acme.test", "lead@acme.test"] } }]);

    const [reply] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Re: Printer on fire", headers: { "In-Reply-To": "<first@cust.example>" } })));
    expect(reply).toMatchObject({ ticketRef: a!.ticketRef, created: false });
    expect(await notified(a!.ticketRef)).toHaveLength(1);

    const [forged] = await runOne(() => deliver(rawEmail({ from: "bob@cust.example", to: SUPPORT, subject: "Unverified", authResults: null }), "bob@cust.example"));
    expect(await notified(forged!.ticketRef)).toHaveLength(1);
  });

  it("never notifies for automated mail", async () => {
    const [r] = await runOne(() => deliver(rawEmail({ from: CUSTOMER, to: SUPPORT, subject: "Out of office", headers: { "Auto-Submitted": "auto-replied" } })));
    expect(await notified(r!.ticketRef)).toEqual([]);
  });

  it("builds a staff email with the facts, a link and the message, escaped", () => {
    const mailbox = { id: "m", address: SUPPORT, name: "Acme Support", refPrefix: "ACME", fromName: null, partition: null, notifyNewTicket: [] };
    const ticket = { ref: "ACME-000007", subject: "Help <b>now</b>", priority: "high" } as Ticket;
    const inbound = { from: { address: CUSTOMER, name: "Jane" }, attachments: [{}] } as unknown as InboundMessageMeta;
    const classification = { category: "billing", confidence: 0.9, codeRelated: false, summary: "Double charge", acceptedBy: "llm", attempts: [] };
    const n = newTicketTemplate({ mailbox, ticket, inbound, body: "I was charged twice.", senderVerified: false, classification, ticketUrl: ticketUrl("https://desk.test/t/{ref}", ticket.ref) });
    expect(n.subject).toBe("[ACME-000007] New ticket: Help <b>now</b>");
    expect(n.text).toContain("From: Jane <jane@cust.example> (sender not verified");
    expect(n.text).toContain("Category: billing\nPriority: high\nSummary: Double charge\nAttachments: 1");
    expect(n.text).toContain("Open: https://desk.test/t/ACME-000007");
    expect(n.text).toContain("I was charged twice.");
    expect(n.html).toContain("Help &#60;b&#62;now&#60;/b&#62;");
    expect(ticketUrl("javascript:alert(1)//{ref}", "X")).toBeUndefined();
    expect(newTicketTemplate({ mailbox, ticket, inbound, body: "x".repeat(NOTIFY_BODY_MAX + 1), senderVerified: true }).text).toContain("[… truncated");
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

describe("htmlToText", () => {
  it.each([
    ["<p>a</p><p>b</p>", "a\n\nb"],
    ["line<br/>break", "line\nbreak"],
    ["&lt;b&gt; &#65;&#x42; &bogus; &#xD800;", "<b> AB &bogus;"],
    ['<a href="https://a.example">https://a.example</a>', "https://a.example"],
    ['<a href="javascript:alert(1)">x</a>', "x"],
    ["<!-- hidden --><title>T</title>shown", "shown"],
    ["   ", ""],
  ])("%s", (html, text) => expect(htmlToText(html)).toBe(text));
});
