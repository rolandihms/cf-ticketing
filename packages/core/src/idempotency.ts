import { normalizeMessageId } from "./threading";

async function sha256Hex(input: string | ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IngestKeyInput {
  mailbox: string;
  messageId: string | null;
  from: string;
  date: string | null;
  subject: string | null;
  /** Body bytes used only when Message-ID is absent. Must exclude transport headers (Received:, etc). */
  body: Uint8Array<ArrayBuffer>;
}

/**
 * Stable per-mailbox key for an inbound message, used as Workflow instance id and dedupe key.
 * - Scoped to the mailbox, so the same mail CC'd to two mailboxes becomes two tickets.
 * - Stable across MTA redelivery (never hashes transport headers).
 * Returns 64 hex chars, which satisfies the Workflow id regex and the 100-char limit.
 */
export async function computeIngestKey(i: IngestKeyInput): Promise<string> {
  const mid = normalizeMessageId(i.messageId);
  const identity = mid
    ? `mid:${mid}`
    : `fallback:${i.from.toLowerCase()}\n${i.date ?? ""}\n${i.subject ?? ""}\n${await sha256Hex(i.body)}`;
  return sha256Hex(`${i.mailbox.toLowerCase()}\n${identity}`);
}

export { sha256Hex };
