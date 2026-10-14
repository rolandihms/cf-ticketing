import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { D1Repo } from "../src/db/repo";
import { inboundMessage, rawEmail } from "./helpers";

const SUPPORT = "support@acme.test";
const CUSTOMER = "jane@cust.example";

async function deliver(raw: string, from = CUSTOMER, to = SUPPORT, overrides: Partial<Env> = {}) {
  const msg = inboundMessage(from, to, raw);
  await worker.email(msg, { ...env, ...overrides });
  return msg;
}

async function runOne(fn: () => Promise<unknown>) {
  await using introspector = await introspectWorkflow(env.INBOUND_WORKFLOW);
  await fn();
  const instances = await introspector.get();
  const outputs = [];
  for (const i of instances) {
    await i.waitForStatus("complete");
    outputs.push(await i.getOutput());
  }
  return outputs as { ticketRef: string; created: boolean; threadedBy: string; acked: boolean }[];
}

const repo = () => new D1Repo(env.DB);

beforeEach(async () => {
  for (const t of ["attachments", "ticket_events", "messages", "tickets", "contacts", "counters", "mailboxes"]) {
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
