export interface GuardInput {
  envelopeFrom: string;
  headers: { get(name: string): string | null };
  ownAddresses: string[];
  /**
   * The topmost Authentication-Results header of the raw message (the one the receiving MTA added),
   * or null. Lower ones can come from anyone, so only the first is ever read.
   */
  authenticationResults?: string | null;
  /** Auth-serv-ids we trust to have written that header. Default: Cloudflare Email Routing's. */
  trustedAuthServIds?: string[];
  /** Treat the From address as proven only on dmarc=pass. Default true. */
  requireDmarc?: boolean;
}

/** DMARC result for the header From, as the receiving MTA saw it. "unverified": no header from a trusted MTA. */
export type DmarcVerdict = "pass" | "fail" | "none" | "unverified";

export interface GuardResult {
  /** Store the mail and create/append a ticket. */
  accept: boolean;
  /** Send an automatic acknowledgement. Never true for automated mail or an unproven sender. */
  allowAutoReply: boolean;
  /**
   * The From address is proven (DMARC pass, or the check is off). Without it the sender could be
   * anyone, so we neither thread on a guessable ticket ref nor send mail to the address.
   */
  senderVerified: boolean;
  dmarc: DmarcVerdict;
  reasons: string[];
}

export const CLOUDFLARE_AUTHSERV_IDS = ["mx.cloudflare.net"];

const AUTOMATED_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+@._-]|$)/i;

/**
 * DMARC verdict from an Authentication-Results header (RFC 8601): `authserv-id [version]; method=result ...`.
 * Only a header written by a trusted auth-serv-id counts.
 */
export function dmarcVerdict(header: string | null | undefined, trusted: string[] = CLOUDFLARE_AUTHSERV_IDS): DmarcVerdict {
  if (!header) return "unverified";
  const [id, ...results] = header.split(";");
  const authserv = id!.trim().split(/\s+/)[0]!.toLowerCase();
  if (!trusted.some((t) => t.toLowerCase() === authserv)) return "unverified";
  for (const r of results) {
    const m = /^\s*dmarc\s*=\s*([a-z]+)/i.exec(r);
    if (m) {
      const v = m[1]!.toLowerCase();
      return v === "pass" ? "pass" : v === "none" ? "none" : "fail";
    }
  }
  return "none";
}

/**
 * Loop and backscatter guards (RFC 3834). Automated mail is still stored as a ticket message
 * (so nothing is lost) but never auto-replied to. Mail from our own mailboxes is dropped.
 * Mail whose From address isn't proven by DMARC is stored too, but gets no ack (no backscatter
 * to forged addresses) and can't join a ticket by its subject ref.
 */
export function evaluateInbound({ envelopeFrom, headers, ownAddresses, authenticationResults, trustedAuthServIds, requireDmarc = true }: GuardInput): GuardResult {
  const reasons: string[] = [];
  const from = envelopeFrom.trim().toLowerCase();
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const dmarc = dmarcVerdict(authenticationResults, trustedAuthServIds);
  const senderVerified = !requireDmarc || dmarc === "pass";

  if (own.has(from)) return { accept: false, allowAutoReply: false, senderVerified, dmarc, reasons: ["from-own-mailbox"] };
  if (headers.get("x-helpdesk-ticket")) {
    return { accept: false, allowAutoReply: false, senderVerified, dmarc, reasons: ["own-outbound-loop"] };
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
  if (!senderVerified) reasons.push(`dmarc-${dmarc}`);

  return { accept: true, allowAutoReply: reasons.length === 0, senderVerified, dmarc, reasons };
}

/**
 * The first (topmost) value of a header in a raw RFC 5322 message, unfolded. Headers higher up were
 * added later in transit, so the first Authentication-Results is the one our own MTA wrote.
 */
export function firstHeader(raw: Uint8Array, name: string): string | null {
  let end = raw.length;
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] === 10 && (raw[i + 1] === 10 || (raw[i + 1] === 13 && raw[i + 2] === 10))) {
      end = i;
      break;
    }
  }
  const block = new TextDecoder("latin1").decode(raw.subarray(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const want = name.toLowerCase() + ":";
  for (const line of block.split(/\r?\n/)) {
    if (line.toLowerCase().startsWith(want)) return line.slice(want.length).trim();
  }
  return null;
}
