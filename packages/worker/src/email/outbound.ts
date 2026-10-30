import { EmailMessage } from "cloudflare:email";
import { NonRetryableError } from "cloudflare:workflows";
import { buildMime, type MimeAddress } from "./mime";

export interface OutboundEmail {
  from: MimeAddress;
  to: MimeAddress;
  subject: string;
  text: string;
  html?: string | null;
  /** Our own Message-ID ("<id@domain>"), stored so customer replies thread back to the ticket. */
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  ticketRef: string;
  /** RFC 3834: mark automatic mail so autoresponders don't reply. true: an ack ("auto-replied"). */
  autoSubmitted?: boolean | "auto-generated";
}

export type SendFormat = "raw" | "builder";

export function threadingHeaders(m: OutboundEmail): Record<string, string> {
  const h: Record<string, string> = { "X-Helpdesk-Ticket": m.ticketRef };
  if (m.inReplyTo) h["In-Reply-To"] = m.inReplyTo;
  const refs = [...(m.references ?? [])].slice(-20);
  if (m.inReplyTo && !refs.includes(m.inReplyTo)) refs.push(m.inReplyTo);
  if (refs.length) h["References"] = refs.join(" ");
  if (m.autoSubmitted) h["Auto-Submitted"] = m.autoSubmitted === true ? "auto-replied" : m.autoSubmitted;
  return h;
}

export function toRawMime(m: OutboundEmail): string {
  return buildMime({
    from: m.from,
    to: [m.to],
    subject: m.subject,
    text: m.text,
    html: m.html,
    messageId: m.messageId,
    headers: threadingHeaders(m),
  });
}

const PERMANENT = /E_RECIPIENT_SUPPRESSED|E_SENDER_NOT_VERIFIED|E_SENDER_DOMAIN_NOT_AVAILABLE|E_VALIDATION|E_HEADER|not allowed|invalid/i;

/** Send through the Email Sending binding. Permanent failures become NonRetryableError. */
export async function sendViaBinding(binding: SendEmail, m: OutboundEmail, format: SendFormat): Promise<{ providerMessageId: string | null }> {
  try {
    const res =
      format === "builder"
        ? await binding.send({
            from: { email: m.from.email, name: m.from.name ?? "" },
            to: m.to.email,
            subject: m.subject,
            text: m.text,
            ...(m.html ? { html: m.html } : {}),
            headers: threadingHeaders(m),
          })
        : await binding.send(new EmailMessage(m.from.email, m.to.email, toRawMime(m)));
    return { providerMessageId: res?.messageId ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (PERMANENT.test(msg)) throw new NonRetryableError(`email send failed permanently: ${msg}`);
    throw err; // includes E_DAILY_LIMIT_EXCEEDED: retried with backoff
  }
}

export function newMessageId(domain: string): string {
  return `<${crypto.randomUUID()}@${domain.toLowerCase()}>`;
}
