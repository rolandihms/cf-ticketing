// Behaviour every HelpdeskRepo implementation must satisfy. Run per dialect by *.test.ts files.
import type { Mailbox } from "@cf-helpdesk/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { HelpdeskRepo, NewMessage } from "../src/repo";

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

    it("lists tickets with cursor pagination", async () => {
      const c = await repo.upsertContact("jane@cust.example", null);
      for (let i = 1; i <= 3; i++) {
        await repo.createTicketWithFirstMessage({ mailbox, requesterId: c.id, subject: `T${i}`, sourceIngestKey: key(i), message: inbound(key(i)), attachments: [] });
      }
      const page1 = await repo.listTickets({ limit: 2 });
      const page2 = await repo.listTickets({ limit: 2, cursor: page1[1]!.id });
      expect([...page1, ...page2].map((t) => t.number)).toEqual([3, 2, 1]);
    });
  });
}

export const TABLES = ["ticket_links", "ticket_classifications", "attachments", "ticket_events", "messages", "tickets", "contacts", "agents", "counters", "mailboxes"] as const;
