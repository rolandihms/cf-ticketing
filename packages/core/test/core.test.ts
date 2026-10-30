import { describe, expect, it } from "vitest";
import {
  computeIngestKey,
  dmarcVerdict,
  evaluateInbound,
  firstHeader,
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
  const PASS = "mx.cloudflare.net; spf=pass smtp.mailfrom=cust.com; dkim=pass header.d=cust.com; dmarc=pass header.from=cust.com";
  it("accepts a normal human email", () => {
    expect(evaluateInbound({ envelopeFrom: "jane@cust.com", headers: h({}), ownAddresses: own, authenticationResults: PASS })).toEqual({
      accept: true, allowAutoReply: true, senderVerified: true, dmarc: "pass", reasons: [],
    });
  });
  it.each([
    [null, "unverified"],
    ["mx.cloudflare.net; dmarc=fail header.from=cust.com", "fail"],
    ["mx.cloudflare.net; dmarc=none header.from=cust.com", "none"],
    ["mx.cloudflare.net; spf=pass smtp.mailfrom=cust.com", "none"],
    ["mx.cloudflare.net; dmarc=temperror", "fail"],
    // Written by someone else (a forged header the sender put in the message): not trusted.
    ["evil.example; dmarc=pass header.from=cust.com", "unverified"],
  ])("stores mail from an unproven sender but never acks it or trusts its From (%s)", (auth, verdict) => {
    const r = evaluateInbound({ envelopeFrom: "jane@cust.com", headers: h({}), ownAddresses: own, authenticationResults: auth });
    expect(r).toMatchObject({ accept: true, allowAutoReply: false, senderVerified: false, dmarc: verdict });
    expect(r.reasons).toEqual([`dmarc-${verdict}`]);
  });
  it("accepts an authserv-id with a version, other trusted ids, and requireDmarc: false", () => {
    expect(dmarcVerdict("MX.Cloudflare.net 1; dmarc=PASS header.from=a.com")).toBe("pass");
    expect(dmarcVerdict("mx.example.org; dmarc=pass", ["mx.example.org"])).toBe("pass");
    expect(evaluateInbound({ envelopeFrom: "jane@cust.com", headers: h({}), ownAddresses: own, requireDmarc: false })).toMatchObject({
      allowAutoReply: true, senderVerified: true, dmarc: "unverified",
    });
  });
  it("reads only the topmost Authentication-Results, unfolded", () => {
    const raw = (s: string) => new TextEncoder().encode(s);
    const msg = "Authentication-Results: mx.cloudflare.net;\r\n dmarc=fail header.from=a.com\r\nAuthentication-Results: mx.cloudflare.net; dmarc=pass\r\nSubject: x\r\n\r\nAuthentication-Results: body";
    expect(firstHeader(raw(msg), "authentication-results")).toBe("mx.cloudflare.net; dmarc=fail header.from=a.com");
    expect(firstHeader(raw("Subject: x\n\nAuthentication-Results: mx.cloudflare.net; dmarc=pass"), "Authentication-Results")).toBeNull();
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
    const r = evaluateInbound({ envelopeFrom: from, headers: h(hdrs as Record<string, string>), ownAddresses: own, authenticationResults: PASS });
    expect(r.accept).toBe(true);
    expect(r.allowAutoReply).toBe(false);
  });
});
