import { describe, expect, it } from "vitest";
import {
  computeIngestKey,
  evaluateInbound,
  findRefsInSubject,
  formatRef,
  normalizeMessageId,
  referencedMessageIds,
  subjectWithRef,
} from "../src";

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

describe("refs", () => {
  it("formats and finds bracketed refs", () => {
    expect(formatRef("ACME", 123)).toBe("ACME-000123");
    expect(findRefsInSubject("Re: [acme-000123] printer", "ACME")).toEqual(["ACME-000123"]);
    expect(findRefsInSubject("ACME-000123 without brackets", "ACME")).toEqual([]);
    expect(subjectWithRef("Re: [ACME-000001] x", "ACME-000001")).toBe("Re: [ACME-000001] x");
    expect(subjectWithRef("", "ACME-000002")).toBe("[ACME-000002] (no subject)");
  });
});

describe("threading", () => {
  it("normalises message ids", () => {
    expect(normalizeMessageId(" <Abc@Mail.Example.COM> ")).toBe("<Abc@mail.example.com>");
    expect(normalizeMessageId("abc@x.io")).toBe("<abc@x.io>");
    expect(normalizeMessageId("garbage")).toBeNull();
  });
  it("orders parent first, then newest references", () => {
    expect(referencedMessageIds("<c@x>", "<a@x> <b@x> <c@x>")).toEqual(["<c@x>", "<b@x>", "<a@x>"]);
  });
});

describe("ingest key", () => {
  const base = { mailbox: "support@acme.com", from: "a@b.com", date: null, subject: "hi", body: new Uint8Array([1]) };
  it("is scoped per mailbox and stable", async () => {
    const a = await computeIngestKey({ ...base, messageId: "<m1@b.com>" });
    const b = await computeIngestKey({ ...base, messageId: "<m1@B.COM>" });
    const c = await computeIngestKey({ ...base, mailbox: "sales@acme.com", messageId: "<m1@b.com>" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("falls back to body hash without Message-ID", async () => {
    const a = await computeIngestKey({ ...base, messageId: null });
    const b = await computeIngestKey({ ...base, messageId: null, body: new Uint8Array([2]) });
    expect(a).not.toBe(b);
  });
});

describe("guards", () => {
  const own = ["support@acme.com"];
  it("accepts a normal human email", () => {
    expect(evaluateInbound({ envelopeFrom: "jane@cust.com", headers: h({}), ownAddresses: own })).toEqual({
      accept: true, allowAutoReply: true, reasons: [],
    });
  });
  it("drops our own mail", () => {
    expect(evaluateInbound({ envelopeFrom: "SUPPORT@acme.com", headers: h({}), ownAddresses: own }).accept).toBe(false);
    expect(evaluateInbound({ envelopeFrom: "x@y.com", headers: h({ "x-helpdesk-ticket": "A-1" }), ownAddresses: own }).accept).toBe(false);
  });
  it.each([
    ["mailer-daemon@x.com", {}],
    ["", {}],
    ["noreply@x.com", {}],
    ["a@x.com", { "auto-submitted": "auto-replied" }],
    ["a@x.com", { precedence: "bulk" }],
    ["a@x.com", { "list-id": "<l.x.com>" }],
    ["a@x.com", { "x-auto-response-suppress": "All" }],
    ["a@x.com", { "content-type": "multipart/report; report-type=delivery-status" }],
  ])("stores but never auto-replies to automated mail (%s)", (from, hdrs) => {
    const r = evaluateInbound({ envelopeFrom: from, headers: h(hdrs as Record<string, string>), ownAddresses: own });
    expect(r.accept).toBe(true);
    expect(r.allowAutoReply).toBe(false);
  });
});
