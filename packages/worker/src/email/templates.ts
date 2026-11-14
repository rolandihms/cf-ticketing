import type { InboundMessageMeta, Mailbox, MailboxLanguage, Ticket } from "@cf-helpdesk/core";
import { subjectWithRef } from "@cf-helpdesk/core";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The language an acknowledgement is actually written in ("auto" resolves to one of these). */
export type AckLanguage = Exclude<MailboxLanguage, "auto">;

/**
 * Best-effort CJK-ratio detection: any meaningful share of CJK characters → Chinese, else English.
 * The mailbox's `language` setting overrides this ("auto"/null = detect from the inbound preview).
 */
export function detectLanguage(text: string): AckLanguage {
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cjk > 0 && cjk >= latin * 0.3 ? "zh" : "en";
}

const ackLanguage = (mailbox: Mailbox, inbound: InboundMessageMeta): AckLanguage => {
  const pref = mailbox.language ?? "auto";
  return pref === "auto" ? detectLanguage(inbound.textPreview) : pref;
};

/** En: exactly the historical `Re: ` behaviour. Zh: same idea with 回覆: and its look-alikes. */
function replySubject(subject: string, lang: AckLanguage): string {
  if (lang === "en") return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  return /^(re\s*:|回覆[:：]|答覆[:：])/i.test(subject) ? subject : `回覆:${subject}`;
}

const ACK: Record<AckLanguage, { greeting: (name: string | null) => string; thanks: (team: string, ref: string) => string; thanksHtml: (team: string, ref: string) => string; replyHint: string }> = {
  en: {
    greeting: (name) => (name ? `Hi ${name},` : "Hi,"),
    thanks: (team, ref) => `Thanks for contacting ${team}. We've received your message and opened ticket ${ref}.`,
    thanksHtml: (team, ref) => `Thanks for contacting ${esc(team)}. We've received your message and opened ticket <strong>${esc(ref)}</strong>.`,
    replyHint: "Reply to this email to add more information to your ticket. Please keep the ticket number in the subject line.",
  },
  zh: {
    greeting: (name) => (name ? `${name} 您好,` : "您好,"),
    thanks: (team, ref) => `感謝您聯絡 ${team}。我們已收到您的訊息,並建立工單 ${ref}。`,
    thanksHtml: (team, ref) => `感謝您聯絡 ${esc(team)}。我們已收到您的訊息,並建立工單 <strong>${esc(ref)}</strong>。`,
    replyHint: "直接回覆此信即可補充更多資訊;請保留主旨中的工單編號,以利系統歸檔。",
  },
};

export function ackTemplate(mailbox: Mailbox, ticket: Ticket, inbound: InboundMessageMeta) {
  const team = mailbox.fromName || mailbox.name;
  const lang = ackLanguage(mailbox, inbound);
  const t = ACK[lang];
  const greeting = t.greeting(inbound.from.name);
  const subject = subjectWithRef(replySubject(inbound.subject, lang), ticket.ref);
  const text = [greeting, "", t.thanks(team, ticket.ref), "", t.replyHint, "", `— ${team}`].join("\n");
  const html = `<p>${esc(greeting)}</p>` + `<p>${t.thanksHtml(team, ticket.ref)}</p>` + `<p>${esc(t.replyHint)}</p>` + `<p>— ${esc(team)}</p>`;
  return { subject, text, html };
}
