// Behaviour every HelpdeskRepo implementation must satisfy. Run per dialect by *.test.ts files.
import type { Mailbox } from "@rolandihms/helpdesk-core";
import { beforeEach, describe, expect, it } from "vitest";
import { type HelpdeskRepo, type NewMessage, PARTITION_GRANT_TTL, type SqlRepo } from "../src/repo";

export function inbound(ingestKey: string, overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    direction: "inbound",
    kind: "customer",
    ingest_key: ingestKey,
    message_id_hdr: `<${ingestKey}@cust.example>`,
    provider_msg_id: null,
    in_reply_to: null,
    from_addr: "jane@cust.example",
    to_json: '["support@acme.test"]',
    cc_json: null,
    subject: "Printer on fire",
    text_preview: "help",
    text_r2_key: null,
    html_r2_key: null,
    raw_r2_key: null,
    auth_json: null,
    author_agent_id: null,
    ...overrides,
  };
}

const key = (n: number) => n.toString(16).padStart(64, "0");

export function repoContract(name: string, makeRepo: () => Promise<HelpdeskRepo>, reset: (repo: HelpdeskRepo) => Promise<void>) {
  describe(`HelpdeskRepo contract: ${name}`, () => {
    let repo: HelpdeskRepo;
    let mailbox: Mailbox;

    beforeEach(async () => {
      repo = await makeRepo();
      await reset(repo);
      mailbox = await repo.createMailbox({ address: "Support@Acme.test", name: "Acme", refPrefix: "acme" });
    });

    it("creates mailboxes idempotently and lower-cases addresses", async () => {
      const again = await repo.createMailbox({ address: "support@acme.test", name: "Other", refPrefix: "X" });
      expect(again.id).toBe(mailbox.id);
      expect(mailbox).toMatchObject({ address: "support@acme.test", refPrefix: "ACME" });
      expect(await repo.listMailboxAddresses()).toEqual(["support@acme.test"]);
    });

    it("upserts contacts; comparisons are byte-exact on every backend", async () => {
      const a = await repo.upsertContact("Jane@Cust.example", "Jane");
      const b = await repo.upsertContact("jane@cust.example", null);
      expect(b.id).toBe(a.id);
      // MySQL's default *_ai_ci collation would treat these as the same contact.
      const jose = await repo.upsertContact("jose@cust.example", null);
      const josé = await repo.upsertContact("josé@cust.example", null);
      expect(josé.id).not.toBe(jose.id);
    });

    it("matches Message-IDs case-sensitively", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({
        mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1),
        message: inbound(key(1), { message_id_hdr: "<AbC@cust.example>" }), attachments: [],
      });
      expect((await repo.findTicketByMessageIds(mailbox.id, ["<AbC@cust.example>"]))?.id).toBe(ticket.id);
      expect(await repo.findTicketByMessageIds(mailbox.id, ["<abc@cust.example>"])).toBeNull();
    });

    it("allocates sequential refs per mailbox, also under concurrency", async () => {
      const c = await repo.upsertContact("jane@cust.example", "Jane");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: `T${i}`, sourceIngestKey: key(i), message: inbound(key(i)), attachments: [] }),
        ),
      );
      expect(results.map((r) => r.ticket.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(results.find((r) => r.ticket.number === 3)!.ticket.ref).toBe("ACME-000003");

      const other = await repo.createMailbox({ address: "sales@acme.test", name: "Sales", refPrefix: "SALE" });
      const s = await repo.createTicketWithFirstMessage({ mailbox: other, requesterId: c.id, subject: "x", sourceIngestKey: key(99), message: inbound(key(99)), attachments: [] });
      expect(s.ticket.ref).toBe("SALE-000001");
    });

    it("rolls back the whole ticket when a write fails (duplicate ingest key)", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      await expect(
        repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "b", sourceIngestKey: key(2), message: inbound(key(1)), attachments: [] }),
      ).rejects.toThrow();
      expect(await repo.listTickets({ limit: 10 })).toHaveLength(1);
      // Counter was rolled back too: the next ticket is #2, not #3.
      const next = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "c", sourceIngestKey: key(3), message: inbound(key(3)), attachments: [] });
      expect(next.ticket.number).toBe(2);
    });

    it("finds tickets by ingest key, message ids (ours or provider's) and ref", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      await repo.appendMessage({
        ticket,
        reopen: false,
        actor: "system:ack",
        attachments: [],
        message: inbound("", { direction: "outbound", kind: "ack", ingest_key: null, message_id_hdr: "<ours@acme.test>", provider_msg_id: "<theirs@acme.test>" }),
      });
      expect(await repo.findInboundByIngestKey(key(1))).toMatchObject({ ticketId: ticket.id, createdTicket: true });
      expect((await repo.findTicketByMessageIds(mailbox.id, ["<nope@x>", "<theirs@acme.test>"]))?.id).toBe(ticket.id);
      expect((await repo.findTicketByMessageIds(mailbox.id, ["<ours@acme.test>"]))?.id).toBe(ticket.id);
      expect(await repo.findTicketByMessageIds(mailbox.id, ["<nope@x>"])).toBeNull();
      expect((await repo.findTicketByRef("acme-000001"))?.id).toBe(ticket.id);
    });

    it("appends messages with attachments and reopens solved tickets", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({
        mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)),
        attachments: [{ r2Key: "k1", filename: "a.png", mimeType: "image/png", size: 10 }],
      });
      await repo.appendMessage({ ticket: { ...ticket, status: "solved" }, reopen: true, actor: "contact:x", attachments: [], message: inbound(key(2)) });
      const detail = (await repo.getTicketDetail(ticket.ref))!;
      expect(detail.ticket.status).toBe("open");
      expect(detail.messages).toHaveLength(2);
      expect(typeof detail.messages[0]!.created_at).toBe("number");
      expect(detail.events.map((e) => e.type)).toEqual(["ticket.created", "message.inbound"]);
      expect(detail.requester?.email).toBe("jane@cust.example");
      expect(detail.attachments).toEqual([expect.objectContaining({ message_id: detail.messages[0]!.id, filename: "a.png", mime_type: "image/png", size: 10 })]);
      expect(await repo.getAttachment(detail.attachments[0]!.id)).toEqual(detail.attachments[0]);
      expect(await repo.getAttachment("nope")).toBeNull();
    });

    it("saves classifications atomically and idempotently", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket, messageId } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      const outcome = {
        category: "bug",
        confidence: 0.9,
        codeRelated: true,
        priority: "high" as const,
        summary: "App crashes on export",
        acceptedBy: "llm",
        attempts: [
          { classifier: "rules", result: null, durationMs: 1 },
          { classifier: "llm", result: { category: "bug", confidence: 0.9, codeRelated: true, summary: "App crashes on export" }, meta: { provider: "workers-ai", model: "m", logId: "log1" }, durationMs: 250 },
        ],
      };
      await repo.saveClassification({ ticket, messageId, outcome });
      await repo.saveClassification({ ticket, messageId, outcome }); // retried step: no duplicates

      const d = (await repo.getTicketDetail(ticket.ref))!;
      expect(d.ticket).toMatchObject({ category: "bug", categoryConfidence: 0.9, codeRelated: true, summary: "App crashes on export", priority: "high" });
      expect(d.classifications.map((x) => [x.classifier, Number(x.accepted), x.category])).toEqual([["rules", 0, null], ["llm", 1, "bug"]]);
      expect(d.classifications[1]).toMatchObject({ provider: "workers-ai", model: "m", log_id: "log1" });
      expect(d.events.filter((e) => e.type === "ticket.classified")).toHaveLength(1);

      // A human-set priority is never overridden.
      await repo.saveClassification({ ticket: { ...d.ticket, priority: "low" }, messageId, outcome: { ...outcome, priority: "urgent" } });
      expect((await repo.getTicket(ticket.id))!.priority).toBe("high");
    });

    it("saves external links once per (ticket, provider)", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      expect(await repo.getLink(ticket.id, "github")).toBeNull();
      const first = await repo.saveLink(ticket.id, { provider: "github", externalId: "acme/app#7", url: "https://github.com/acme/app/issues/7", state: "open", data: { number: 7 } });
      const second = await repo.saveLink(ticket.id, { provider: "github", externalId: "acme/app#8", url: null, state: "open" });
      expect(second).toEqual(first);
      expect(first).toMatchObject({ externalId: "acme/app#7", data: { number: 7 } });
    });

    it("copies the mailbox partition to tickets and filters by it", async () => {
      const other = await repo.createMailbox({ address: "help@tenant.test", name: "Tenant", refPrefix: "TEN", partition: "company:42" });
      expect(other.partition).toBe("company:42");
      expect(mailbox.partition).toBeNull();
      const c = await repo.upsertContact("jane@cust.example", null);
      const mk = (mb: typeof mailbox, k: number) =>
        repo.createTicketWithFirstMessage({ mailbox: mb, requesterId: c.id, subject: "x", sourceIngestKey: key(k), message: inbound(key(k)), attachments: [] });
      const { ticket: t1 } = await mk(other, 900);
      const { ticket: t2 } = await mk(mailbox, 901);
      expect(t1.partition).toBe("company:42");
      expect(t2.partition).toBeNull();
      expect((await repo.listTickets({ limit: 10, partition: "company:42" })).map((t) => t.id)).toEqual([t1.id]);
      expect((await repo.listTickets({ limit: 10, partition: "company:7" }))).toEqual([]);
      expect((await repo.listTickets({ limit: 10 })).length).toBe(2);
      expect((await repo.listMailboxes({ partition: "company:42" })).map((m) => m.id)).toEqual([other.id]);
      expect((await repo.getTicketDetail(t1.ref))?.ticket.partition).toBe("company:42");

      const global = await repo.createAgent({ email: "g@acme.test", name: "G", role: "admin" });
      const scoped = await repo.createAgent({ email: "s@acme.test", name: "S", role: "agent", partition: "company:42" });
      await repo.createAgent({ email: "o@acme.test", name: "O", role: "agent", partition: "company:7" });
      expect((await repo.listAgents({ partition: "company:42" })).map((a) => a.id).sort()).toEqual([global.id, scoped.id].sort());
      expect((await repo.updateAgent(scoped.id, { partition: null }))?.partition).toBeNull();
    });

    it("provisions and re-syncs agents from trusted external identities", async () => {
      const a = await repo.upsertAgentByExternalId({ externalId: "user_1", email: "Kim@Host.test", name: "Kim", role: "agent", partition: null });
      expect(a).toMatchObject({ externalId: "user_1", email: "kim@host.test", role: "agent", active: true, partition: null });
      // Role, name and email follow the host; a deactivated agent is reactivated by the host.
      await repo.updateAgent(a.id, { active: false });
      const b = await repo.upsertAgentByExternalId({ externalId: "user_1", email: "kim2@host.test", name: "Kim B", role: "admin", partition: null });
      expect(b).toMatchObject({ id: a.id, email: "kim2@host.test", name: "Kim B", role: "admin", active: true });
      // An existing agent with the same email and no external id is linked, not duplicated.
      const pre = await repo.createAgent({ email: "lee@host.test", name: "Lee", role: "agent" });
      expect((await repo.upsertAgentByExternalId({ externalId: "user_2", email: "lee@host.test", name: "Lee", role: "agent", partition: null })).id).toBe(pre.id);
      // …but an email owned by a different external user is a conflict.
      await expect(repo.upsertAgentByExternalId({ externalId: "user_3", email: "lee@host.test", name: "X", role: "agent", partition: null })).rejects.toThrow(/another external user/);
      // Concurrent first requests create exactly one agent.
      const many = await Promise.all([1, 2, 3, 4].map(() => repo.upsertAgentByExternalId({ externalId: "user_9", email: "zed@host.test", name: "Zed", role: "agent", partition: null })));
      expect(new Set(many.map((x) => x.id)).size).toBe(1);
      expect((await repo.listAgents()).filter((x) => x.externalId === "user_9")).toHaveLength(1);
      // Changing to an email another agent owns is a conflict, not a crash.
      await expect(repo.upsertAgentByExternalId({ externalId: "user_9", email: "lee@host.test", name: "Zed", role: "agent", partition: null })).rejects.toThrow(/belongs to another agent/);
    });

    it("lists host-provisioned agents only in partitions they were seen in", async () => {
      const one = await repo.upsertAgentByExternalId({ externalId: "u1", email: "one@host.test", name: "One", role: "agent", partition: "company:1" });
      const two = await repo.upsertAgentByExternalId({ externalId: "u2", email: "two@host.test", name: "Two", role: "agent", partition: "company:2" });
      const staff = await repo.upsertAgentByExternalId({ externalId: "u3", email: "staff@host.test", name: "Staff", role: "admin", partition: null });
      const local = await repo.createAgent({ email: "local@acme.test", name: "Local", role: "agent" });
      const ids = async (p: string) => (await repo.listAgents({ partition: p })).map((a) => a.id).sort();
      expect(await ids("company:1")).toEqual([one.id, staff.id, local.id].sort());
      expect(await ids("company:2")).toEqual([two.id, staff.id, local.id].sort());
      await repo.upsertAgentByExternalId({ externalId: "u1", email: "one@host.test", name: "One", role: "agent", partition: "company:2" });
      expect(await ids("company:2")).toContain(one.id);
      expect((await repo.getAgentPartitions(one.id)).sort()).toEqual(["company:1", "company:2"]);
      expect(await repo.getAgentPartitions(staff.id)).toEqual(["*"]);
    });

    it("withdraws global access when the host scopes an agent, and lets unconfirmed grants lapse", async () => {
      const staff = await repo.upsertAgentByExternalId({ externalId: "u3", email: "staff@host.test", name: "Staff", role: "admin", partition: null });
      const ids = async (p: string) => (await repo.listAgents({ partition: p })).map((a) => a.id);
      expect(await ids("company:9")).toContain(staff.id);
      // The host now sends them for one company only: "*" goes, so they're no longer in every tenant.
      await repo.upsertAgentByExternalId({ externalId: "u3", email: "staff@host.test", name: "Staff", role: "agent", partition: "company:1" });
      expect(await repo.getAgentPartitions(staff.id)).toEqual(["company:1"]);
      expect(await ids("company:9")).not.toContain(staff.id);
      expect(await ids("company:1")).toContain(staff.id);

      // A grant the host hasn't confirmed within the TTL lapses…
      const old = Date.now() - PARTITION_GRANT_TTL - 1000;
      await (repo as unknown as SqlRepo).db.updateTable("agent_partitions").set({ created_at: old }).where("agent_id", "=", staff.id).execute();
      expect(await repo.getAgentPartitions(staff.id)).toEqual([]);
      expect(await ids("company:1")).not.toContain(staff.id);
      // …and comes back (refreshed) the next time the host sends them there.
      await repo.upsertAgentByExternalId({ externalId: "u3", email: "staff@host.test", name: "Staff", role: "agent", partition: "company:1" });
      expect(await repo.getAgentPartitions(staff.id)).toEqual(["company:1"]);
    });

    it("manages agents (idempotent create by email, update, deactivate)", async () => {
      const a = await repo.createAgent({ email: "Ann@Acme.test", name: "Ann", role: "admin" });
      const again = await repo.createAgent({ email: "ann@acme.test", name: "Other", role: "agent" });
      expect(again).toEqual(a);
      expect(a).toMatchObject({ email: "ann@acme.test", role: "admin", active: true });
      expect(await repo.updateAgent(a.id, { active: false, role: "agent" })).toMatchObject({ active: false, role: "agent" });
      expect((await repo.getAgentByEmail("ANN@acme.test"))?.id).toBe(a.id);
      expect((await repo.listAgents()).map((x) => x.email)).toEqual(["ann@acme.test"]);
      expect(await repo.updateAgent("nope", { name: "x" })).toBeNull();
    });

    it("updates status/priority/assignee atomically with one event per change", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const agent = await repo.createAgent({ email: "bob@acme.test", name: "Bob", role: "agent" });
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      const solved = await repo.updateTicket(ticket, { status: "solved", priority: "high", assigneeId: agent.id }, `agent:${agent.id}`);
      expect(solved).toMatchObject({ status: "solved", priority: "high", assigneeId: agent.id });
      const unchanged = await repo.updateTicket(solved, { status: "solved" }, "x");
      expect(unchanged.updatedAt).toBe(solved.updatedAt);
      await repo.updateTicket(solved, { assigneeId: null }, "x");
      const d = (await repo.getTicketDetail(ticket.ref))!;
      expect(d.ticket.assigneeId).toBeNull();
      expect(d.events.map((e) => e.type)).toEqual(["ticket.created", "ticket.status_changed", "ticket.priority_changed", "ticket.assigned", "ticket.assigned"]);
      const closedAt = await (repo as unknown as SqlRepo).db.selectFrom("tickets").select("closed_at").where("id", "=", ticket.id).executeTakeFirstOrThrow();
      expect(Number(closedAt.closed_at)).toBeGreaterThan(0);
    });

    it("rejects stale updates (compare-and-set) without writing events", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      await repo.updateTicket(ticket, { status: "open" }, "alice");
      await expect(repo.updateTicket(ticket, { status: "solved" }, "bob")).rejects.toThrow(/changed by someone else/);
      const d = (await repo.getTicketDetail(ticket.ref))!;
      expect(d.ticket.status).toBe("open");
      expect(d.events.filter((e) => e.type === "ticket.status_changed").map((e) => e.actor)).toEqual(["alice"]);
      // Unrelated fields don't conflict: a stale snapshot can still change priority.
      expect((await repo.updateTicket(ticket, { priority: "high" }, "bob")).priority).toBe("high");
    });

    it("reserves outbound messages idempotently, then completes or discards them", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      const out = inbound("", { direction: "outbound", kind: "agent_reply", ingest_key: key(50), message_id_hdr: "<r1@acme>" });
      const first = await repo.reserveOutbound(ticket, out);
      const again = await repo.reserveOutbound(ticket, out);
      expect(first.existing).toBe(false);
      expect(again).toEqual({ messageId: first.messageId, existing: true });
      await repo.completeOutbound(ticket, first.messageId, "<prov@acme>", "agent:x");
      expect((await repo.getMessage(first.messageId))!.provider_msg_id).toBe("<prov@acme>");

      const failed = await repo.reserveOutbound(ticket, inbound("", { direction: "outbound", kind: "agent_reply", ingest_key: null }));
      await repo.discardMessage(failed.messageId);
      expect(await repo.getMessage(failed.messageId)).toBeNull();
      const types = (await repo.getTicketDetail(ticket.ref))!.events.map((e) => e.type);
      expect(types.filter((x) => x === "message.outbound")).toHaveLength(1);
    });

    it("counts active admins", async () => {
      const a = await repo.createAgent({ email: "a@acme.test", name: "A", role: "admin" });
      await repo.createAgent({ email: "b@acme.test", name: "B", role: "agent" });
      expect(await repo.countActiveAdmins()).toBe(1);
      await repo.updateAgent(a.id, { active: false });
      expect(await repo.countActiveAdmins()).toBe(0);
    });

    it("a customer reply reopens pending/solved/closed tickets", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      const pending = await repo.updateTicket(ticket, { status: "pending" }, "x");
      await repo.appendMessage({ ticket: pending, reopen: true, actor: "contact", attachments: [], message: inbound(key(2)) });
      expect((await repo.getTicket(ticket.id))!.status).toBe("open");
    });

    it("filters tickets by status, assignee, category and text (LIKE-safe)", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const agent = await repo.createAgent({ email: "bob@acme.test", name: "Bob", role: "agent" });
      const mk = async (i: number, subject: string) =>
        (await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject, sourceIngestKey: key(i), message: inbound(key(i)), attachments: [] })).ticket;
      const t1 = await mk(1, "Printer 100% broken");
      const t2 = await mk(2, "Invoice question");
      await mk(3, "Printer jam");
      await repo.updateTicket(t1, { assigneeId: agent.id, status: "open" }, "x");
      await repo.saveClassification({ ticket: t2, messageId: "m", outcome: { category: "billing", confidence: 0.9, codeRelated: false, acceptedBy: "rules", attempts: [] } });

      const refs = async (f: Parameters<HelpdeskRepo["listTickets"]>[0]) => (await repo.listTickets(f)).map((t) => t.number).sort();
      expect(await refs({ limit: 10, statuses: ["open"] })).toEqual([1]);
      expect(await refs({ limit: 10, statuses: ["new", "open"] })).toEqual([1, 2, 3]);
      expect(await refs({ limit: 10, assigneeId: agent.id })).toEqual([1]);
      expect(await refs({ limit: 10, assigneeId: null })).toEqual([2, 3]);
      expect(await refs({ limit: 10, category: "billing" })).toEqual([2]);
      expect(await refs({ limit: 10, q: "PRINTER" })).toEqual([1, 3]);
      expect(await refs({ limit: 10, q: "100%" })).toEqual([1]); // % is literal, not a wildcard
      expect(await refs({ limit: 10, q: "acme-000002" })).toEqual([2]);
    });

    it("computes threading headers from customer and outbound messages, skipping notes", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "a", sourceIngestKey: key(1), message: inbound(key(1), { message_id_hdr: "<c1@cust>" }), attachments: [] });
      await repo.appendMessage({ ticket, reopen: false, actor: "ack", attachments: [], message: inbound("", { direction: "outbound", kind: "ack", ingest_key: null, message_id_hdr: "<ours@acme>", provider_msg_id: "<prov@acme>" }) });
      await repo.appendMessage({ ticket, reopen: false, actor: "a", attachments: [], message: inbound("", { direction: "note", kind: "note", ingest_key: null, message_id_hdr: null }) });
      await repo.appendMessage({ ticket, reopen: true, actor: "c", attachments: [], message: inbound(key(2), { message_id_hdr: "<c2@cust>", from_addr: "jane.alt@cust.example" }) });
      expect(await repo.getThreading(ticket.id)).toEqual({ inReplyTo: "<c2@cust>", references: ["<c1@cust>", "<prov@acme>", "<c2@cust>"], lastCustomerEmail: "jane.alt@cust.example" });
    });

    it("lists tickets with cursor pagination", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      for (let i = 1; i <= 3; i++) {
        await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: `T${i}`, sourceIngestKey: key(i), message: inbound(key(i)), attachments: [] });
      }
      const page1 = await repo.listTickets({ limit: 2 });
      const page2 = await repo.listTickets({ limit: 2, cursor: page1[1]!.id });
      expect([...page1, ...page2].map((t) => t.number)).toEqual([3, 2, 1]);
    });

    it("links requesters to contacts by external id, following email changes and merging mail-only contacts", async () => {
      const mailOnly = await repo.upsertContact("jane@cust.example", "J");
      const jane = await repo.upsertContactByExternalId({ externalId: "u1", email: "Jane@Cust.example", name: "Jane" });
      expect(jane).toEqual({ id: mailOnly.id, email: "jane@cust.example", name: "Jane", externalId: "u1" });
      expect((await repo.upsertContactByExternalId({ externalId: "u1", email: "jane@cust.example", name: "Jane" })).id).toBe(jane.id);

      // A new address that already wrote in: its contact and tickets merge into the user's.
      const other = await repo.upsertContact("jane.new@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: other.id, subject: "Old mail", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      const moved = await repo.upsertContactByExternalId({ externalId: "u1", email: "jane.new@cust.example", name: "Jane N" });
      expect(moved).toEqual({ id: jane.id, email: "jane.new@cust.example", name: "Jane N", externalId: "u1" });
      expect((await repo.getTicket(ticket.id))!.requesterId).toBe(jane.id);
      expect(await repo.getContact(other.id)).toBeNull();

      await expect(repo.upsertContactByExternalId({ externalId: "u2", email: "jane.new@cust.example", name: "Imposter" })).rejects.toThrow(/another external user/);
      const bob = await repo.upsertContactByExternalId({ externalId: "u2", email: "bob@cust.example", name: "" });
      expect((await repo.getContactNames([jane.id, bob.id, jane.id])).get(bob.id)).toBe("bob");
    });

    it("creates portal tickets with source, partition, metadata and a source key; requester filter needs verification", async () => {
      const jane = await repo.upsertContactByExternalId({ externalId: "u1", email: "jane@cust.example", name: "Jane" });
      const bob = await repo.upsertContactByExternalId({ externalId: "u2", email: "bob@cust.example", name: "Bob" });
      const mk = (requesterId: string, n: number, extra: object) =>
        repo.createTicketWithFirstMessage({ mailbox, requesterId, subject: `T${n}`, sourceIngestKey: key(n), message: inbound(key(n)), attachments: [], ...extra });
      const { ticket: a } = await mk(jane.id, 1, { source: "portal", partition: "company:1", metadata: { "site": "42" }, requesterVerified: true, actor: `contact:${jane.id}` });
      await mk(bob.id, 2, { source: "app", partition: "company:1", requesterVerified: true });
      await mk(jane.id, 3, { requesterVerified: false }); // forged mail "from" Jane
      await mk(jane.id, 4, {}); // before 0006: unknown
      expect(a).toMatchObject({ source: "portal", partition: "company:1", metadata: { site: "42" } });
      expect((await repo.findTicketBySourceKey(key(1)))!.id).toBe(a.id);
      expect(await repo.findTicketBySourceKey(key(9))).toBeNull();

      const subjects = async (contactId: string, partition: string | null) => (await repo.listTickets({ limit: 10, requester: { contactId, partition } })).map((t) => t.subject);
      expect(await subjects(jane.id, null)).toEqual(["T1"]);
      expect(await subjects(jane.id, "company:1")).toEqual(["T2", "T1"]);
      expect(await subjects(bob.id, "company:2")).toEqual(["T2"]);
    });

    it("updates metadata and partition with events, compare-and-set", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      const { ticket } = await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: "T", sourceIngestKey: key(1), message: inbound(key(1)), attachments: [] });
      const t1 = await repo.updateTicket(ticket, { metadata: { unit: "7" }, partition: "company:1" }, "api");
      expect(t1).toMatchObject({ metadata: { unit: "7" }, partition: "company:1" });
      await expect(repo.updateTicket(ticket, { metadata: { unit: "8" } }, "api")).rejects.toThrow(/changed by someone else/);
      const t2 = await repo.updateTicket(t1, { metadata: {}, partition: null }, "api");
      expect(t2).toMatchObject({ metadata: {}, partition: null });
      const detail = (await repo.getTicketDetail(ticket.ref))!;
      expect(detail.events.map((e) => e.type).filter((x) => x !== "ticket.created")).toEqual([
        "ticket.metadata_changed", "ticket.partition_changed", "ticket.metadata_changed", "ticket.partition_changed",
      ]);
    });
  });
}

export const TABLES = ["ticket_links", "ticket_classifications", "attachments", "ticket_events", "messages", "tickets", "contacts", "agent_partitions", "agents", "counters", "mailboxes"] as const;
