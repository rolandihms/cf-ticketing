import type { InboundMessageMeta, Mailbox, Ticket } from "@cf-helpdesk/core";
import { describe, expect, it } from "vitest";
import { ackTemplate, detectLanguage } from "../../../packages/worker/src/email/templates";

const mailbox = (language: Mailbox["language"] = null): Mailbox => ({
  id: "m1",
  address: "support@acme.test",
  name: "Acme Support",
  refPrefix: "ACME",
  fromName: "Acme Support",
  partition: null,
  language,
});

const ticket = (ref = "ACME-000123"): Ticket => ({
  id: "t1",
  mailboxId: "m1",
  number: 123,
  ref,
  subject: "Printer",
  status: "new",
  priority: "normal",
  requesterId: "c1",
  assigneeId: null,
  createdAt: 0,
  updatedAt: 0,
  category: null,
  categoryConfidence: null,
  codeRelated: null,
  summary: null,
  partition: null,
});

const inbound = (subject = "Printer on fire", textPreview = "help", fromName: string | null = "Jane"): InboundMessageMeta => ({
  ingestKey: "k1",
  mailboxAddress: "support@acme.test",
  envelopeFrom: "jane@cust.example",
  from: { address: "jane@cust.example", name: fromName },
  to: ["support@acme.test"],
  cc: [],
  subject,
  messageId: null,
  inReplyTo: null,
  references: [],
  date: null,
  rawKey: "r1",
  textKey: "t1",
  htmlKey: null,
  textPreview,
  attachments: [],
});

describe("ackTemplate", () => {
  it("defaults to English with the exact historical copy (no language configured)", () => {
    const { subject, text, html } = ackTemplate(mailbox(), ticket(), inbound());
    expect(subject).toBe("[ACME-000123] Re: Printer on fire");
    expect(text).toBe(
      ["Hi Jane,", "", "Thanks for contacting Acme Support. We've received your message and opened ticket ACME-000123.", "", "Reply to this email to add more information to your ticket. Please keep the ticket number in the subject line.", "", "— Acme Support"].join("\n"),
    );
    expect(html).toBe(
      "<p>Hi Jane,</p>" +
        "<p>Thanks for contacting Acme Support. We've received your message and opened ticket <strong>ACME-000123</strong>.</p>" +
        "<p>Reply to this email to add more information to your ticket. Please keep the ticket number in the subject line.</p>" +
        "<p>— Acme Support</p>",
    );
  });

  it("writes the Chinese acknowledgement when the mailbox language is zh", () => {
    const { subject, text, html } = ackTemplate(mailbox("zh"), ticket(), inbound("印表機著火", "請幫忙"));
    expect(subject).toBe("[ACME-000123] 回覆:印表機著火");
    expect(text).toBe(["Jane 您好,", "", "感謝您聯絡 Acme Support。我們已收到您的訊息,並建立工單 ACME-000123。", "", "直接回覆此信即可補充更多資訊;請保留主旨中的工單編號,以利系統歸檔。", "", "— Acme Support"].join("\n"));
    expect(html).toContain("<strong>ACME-000123</strong>");
    expect(html).toContain("感謝您聯絡 Acme Support");
  });

  it("keeps an existing Re:/回覆: subject prefix instead of stacking a new one", () => {
    expect(ackTemplate(mailbox(), ticket(), inbound("Re: printer")).subject).toBe("[ACME-000123] Re: printer");
    expect(ackTemplate(mailbox("zh"), ticket(), inbound("回覆:印表機")).subject).toBe("[ACME-000123] 回覆:印表機");
    expect(ackTemplate(mailbox("zh"), ticket(), inbound("答覆:印表機")).subject).toBe("[ACME-000123] 答覆:印表機");
  });

  it("auto-detects the language from the inbound preview when language is auto or unset", () => {
    expect(ackTemplate(mailbox("auto"), ticket(), inbound("印表機著火", "您好,我的印表機一直卡紙,請協助處理,謝謝。")).text).toContain("感謝您聯絡");
    expect(ackTemplate(mailbox("auto"), ticket(), inbound("Printer on fire", "My printer keeps jamming, please help")).text).toContain("Thanks for contacting");
    expect(ackTemplate(mailbox(null), ticket(), inbound("印表機著火", "印表機卡紙,請協助")).text).toContain("感謝您聯絡");
    expect(ackTemplate(mailbox(null), ticket(), inbound("Printer on fire", "printer jam")).text).toContain("Thanks for contacting");
  });

  it("falls back to English when the sender has no name", () => {
    const { text } = ackTemplate(mailbox("en"), ticket(), inbound("Printer on fire", "help", null));
    expect(text.startsWith("Hi,\n")).toBe(true);
    const zh = ackTemplate(mailbox("zh"), ticket(), inbound("印表機著火", "help", null));
    expect(zh.text.startsWith("您好,\n")).toBe(true);
  });
});

describe("detectLanguage", () => {
  it("classifies CJK-ratio samples", () => {
    expect(detectLanguage("")).toBe("en");
    expect(detectLanguage("printer jam")).toBe("en");
    expect(detectLanguage("印表機卡紙,請協助處理,謝謝。")).toBe("zh");
    expect(detectLanguage("您好,error code 0x80070002,電腦無法開機,請協助")).toBe("zh");
    // Mostly-latin text with a stray CJK character stays English.
    expect(detectLanguage("please fix my printer 序")).toBe("en");
    expect(detectLanguage("ハンドブック")).toBe("zh"); // kana counts as CJK; the only non-English template is zh
  });
});