import type { InboundMessageMeta } from "@cf-helpdesk/core";
import { normalizeMessageId, referencedMessageIds } from "@cf-helpdesk/core";
import PostalMime, { type Address } from "postal-mime";

export interface StoredRawRef {
  ingestKey: string;
  mailboxId: string;
  mailboxAddress: string;
  envelopeFrom: string;
  rawKey: string;
}

export const r2Prefix = (mailboxId: string, ingestKey: string) => `mail/${mailboxId}/${ingestKey}`;

const flatten = (list: Address[] | undefined): string[] =>
  (list ?? []).flatMap((a) => (a.group ? a.group.map((g) => g.address) : a.address ? [a.address] : [])).map((a) => a.toLowerCase());

/**
 * Parse the raw message stored in R2, write bodies and attachments back to R2, and return
 * metadata only, so the result stays well under the 1 MiB Workflow step-result limit.
 */
export async function parseAndStore(bucket: R2Bucket, ref: StoredRawRef): Promise<InboundMessageMeta> {
  const obj = await bucket.get(ref.rawKey);
  if (!obj) throw new Error(`raw message missing in R2: ${ref.rawKey}`);
  const email = await PostalMime.parse(await obj.arrayBuffer(), { attachmentEncoding: "arraybuffer" });
  const prefix = r2Prefix(ref.mailboxId, ref.ingestKey);

  const fromAddr = email.from && !email.from.group ? email.from : null;
  const text = email.text ?? "";
  const textKey = text ? `${prefix}/body.txt` : null;
  const htmlKey = email.html ? `${prefix}/body.html` : null;
  if (textKey) await bucket.put(textKey, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  if (htmlKey) await bucket.put(htmlKey, email.html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } });

  const attachments: InboundMessageMeta["attachments"] = [];
  for (const [i, a] of email.attachments.entries()) {
    const safeName = (a.filename ?? `part-${i}`).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const key = `${prefix}/att/${i}-${safeName}`;
    const body = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
    await bucket.put(key, body, { httpMetadata: { contentType: a.mimeType } });
    attachments.push({ key, filename: a.filename, mimeType: a.mimeType, size: body.byteLength });
  }

  const date = email.date ? Date.parse(email.date) : NaN;
  return {
    ingestKey: ref.ingestKey,
    mailboxAddress: ref.mailboxAddress,
    envelopeFrom: ref.envelopeFrom.toLowerCase(),
    from: {
      address: (fromAddr?.address || ref.envelopeFrom).toLowerCase(),
      name: fromAddr?.name || null,
    },
    to: flatten(email.to),
    cc: flatten(email.cc),
    subject: (email.subject ?? "").slice(0, 500),
    messageId: normalizeMessageId(email.messageId),
    inReplyTo: normalizeMessageId(email.inReplyTo),
    references: referencedMessageIds(email.inReplyTo ?? null, email.references ?? null),
    date: Number.isNaN(date) ? null : date,
    rawKey: ref.rawKey,
    textKey,
    htmlKey,
    textPreview: text.replace(/\s+/g, " ").trim().slice(0, 500),
    attachments,
  };
}
