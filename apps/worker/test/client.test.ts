// The published client and proxy helper against the real Worker: the contract a host app relies on.
import { createHelpdeskClient, HelpdeskApiError } from "@cf-helpdesk/client";
import { forwardToHelpdesk, type HostIdentity, trustedHeaders } from "@cf-helpdesk/client/server";
import { D1Dialect, D1Repo } from "@cf-helpdesk/db";
import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { introspectWorkflow } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";

const TRUSTED = { ...env, TRUSTED_PRINCIPAL: "on", HELPDESK_SERVICE_KEY: "svc-key" };
const binding = { fetch: (r: Request) => worker.fetch(r, TRUSTED, {} as ExecutionContext) };
const repo = () => new D1Repo(env.DB, new Kysely({ dialect: new D1Dialect(env.DB) }));
const kim: HostIdentity = { externalId: "user_1", email: "kim@host.test", name: "Kim", role: "agent", partition: "company:1" };

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  // Agent actions queue webhook deliveries (see helpdesk.config.ts); answer them locally.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  for (const t of ["ticket_links", "ticket_classifications", "attachments", "ticket_events", "messages", "tickets", "contacts", "counters", "agent_partitions", "agents", "mailboxes"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
});

async function seedTicket(partition: string) {
  const r = repo();
  const n = partition.split(":")[1];
  const mailbox = await r.createMailbox({ address: `help@c${n}.test`, name: "Help", refPrefix: `CO${n}`, partition });
  const c = await r.upsertContact("jane@cust.example", "Jane");
  const key = crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
  return (await r.createTicketWithFirstMessage({
    mailbox, requesterId: c.id, subject: "Gate remote broken", sourceIngestKey: key, attachments: [],
    message: {
      direction: "inbound", kind: "customer", ingest_key: key, message_id_hdr: `<${key.slice(0, 8)}@cust.example>`, provider_msg_id: null,
      in_reply_to: null, from_addr: "jane@cust.example", to_json: "[]", cc_json: null, subject: "Gate remote broken", text_preview: "It stopped working",
      text_r2_key: null, html_r2_key: null, raw_r2_key: null, auth_json: null, author_agent_id: null,
    },
  })).ticket;
}

describe("@cf-helpdesk/client against the Worker", () => {
  it("works a ticket end to end as a trusted host user", async () => {
    const t = await seedTicket("company:1");
    const hd = createHelpdeskClient({ baseUrl: "https://helpdesk.internal/api", fetch: binding.fetch, headers: trustedHeaders("svc-key", kim) });
    await using introspector = await introspectWorkflow(env.INBOUND_WORKFLOW);
    await introspector.modifyAll((m) => m.disableRetryDelays());

    expect(await hd.me()).toMatchObject({ via: "trusted", partition: "company:1", agent: { externalId: "user_1" } });
    const page = await hd.tickets.list({ status: ["new", "open"] });
    expect(page.tickets.map((x) => x.ref)).toEqual([t.ref]);

    const updated = await hd.tickets.update(t.ref, { status: "open", assignee: "me" });
    expect(updated.status).toBe("open");
    const note = await hd.tickets.addNote(t.ref, "Called the customer");
    expect(await hd.messages.text(note.id)).toBe("Called the customer");
    const { ticket } = await hd.tickets.reply(t.ref, { text: "A new remote is on its way.", idempotencyKey: crypto.randomUUID() });
    expect(ticket.status).toBe("pending");

    const detail = await hd.tickets.get(t.ref);
    expect(detail.messages.map((m) => m.kind)).toEqual(["customer", "note", "agent_reply"]);
    expect((await hd.agents.list()).map((a) => a.email)).toEqual(["kim@host.test"]);
    for (const i of await introspector.get()) await i.waitForStatus("complete");
  });

  it("surfaces partition isolation as HelpdeskApiError 404", async () => {
    const other = await seedTicket("company:2");
    const hd = createHelpdeskClient({ baseUrl: "https://helpdesk.internal/api", fetch: binding.fetch, headers: trustedHeaders("svc-key", kim) });
    const err = await hd.tickets.get(other.ref).catch((e) => e);
    expect(err).toBeInstanceOf(HelpdeskApiError);
    expect(err.status).toBe(404);
  });

  it("forwardToHelpdesk proxies a browser request; spoofed identity headers are ignored", async () => {
    const t = await seedTicket("company:1");
    await seedTicket("company:2");
    // The browser tries to claim unrestricted admin; the proxy replaces it with the real user.
    const browser = new Request("https://app.test/api/v1/helpdesk/tickets", {
      headers: { "x-helpdesk-principal": JSON.stringify({ ...kim, role: "admin", partition: null }), cookie: "session=abc" },
    });
    const res = await forwardToHelpdesk(browser, { target: binding, serviceKey: "svc-key", identity: kim, mountPath: "/api/v1/helpdesk" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tickets: { ref: string }[] }).tickets.map((x) => x.ref)).toEqual([t.ref]);
  });
});
