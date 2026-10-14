export interface GuardInput {
  envelopeFrom: string;
  headers: { get(name: string): string | null };
  ownAddresses: string[];
}

export interface GuardResult {
  /** Store the mail and create/append a ticket. */
  accept: boolean;
  /** Send an automatic acknowledgement. Never true for automated mail. */
  allowAutoReply: boolean;
  reasons: string[];
}

const AUTOMATED_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+@._-]|$)/i;

/**
 * Loop and backscatter guards (RFC 3834). Automated mail is still stored as a ticket message
 * (so nothing is lost) but never auto-replied to. Mail from our own mailboxes is dropped.
 */
export function evaluateInbound({ envelopeFrom, headers, ownAddresses }: GuardInput): GuardResult {
  const reasons: string[] = [];
  const from = envelopeFrom.trim().toLowerCase();
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));

  if (own.has(from)) return { accept: false, allowAutoReply: false, reasons: ["from-own-mailbox"] };
  if (headers.get("x-helpdesk-ticket")) {
    return { accept: false, allowAutoReply: false, reasons: ["own-outbound-loop"] };
  }

  if (from === "" || from === "<>") reasons.push("null-envelope-sender");
  if (AUTOMATED_SENDER.test(from)) reasons.push("automated-sender");
  const autoSubmitted = headers.get("auto-submitted");
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== "no") reasons.push("auto-submitted");
  const precedence = headers.get("precedence")?.trim().toLowerCase();
  if (precedence && ["bulk", "list", "junk", "auto_reply"].includes(precedence)) reasons.push(`precedence-${precedence}`);
  if (headers.get("list-id") || headers.get("list-unsubscribe")) reasons.push("mailing-list");
  if (headers.get("x-auto-response-suppress")) reasons.push("auto-response-suppress");
  if (/multipart\/report/i.test(headers.get("content-type") ?? "")) reasons.push("delivery-report");

  return { accept: true, allowAutoReply: reasons.length === 0, reasons };
}
