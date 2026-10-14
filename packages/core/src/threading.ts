/** Normalise a Message-ID header value to `<id@host>` lower-cased host form, or null. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/<([^<>\s]+)>/) ?? value.trim().match(/^([^<>\s]+@[^<>\s]+)$/);
  if (!m) return null;
  const id = m[1]!;
  const at = id.lastIndexOf("@");
  return at < 0 ? `<${id}>` : `<${id.slice(0, at)}@${id.slice(at + 1).toLowerCase()}>`;
}

/** All message ids referenced by In-Reply-To + References, most recent first, de-duplicated. */
export function referencedMessageIds(inReplyTo: string | null, references: string | null): string[] {
  const ids: string[] = [];
  for (const src of [inReplyTo, references]) {
    if (!src) continue;
    for (const m of src.matchAll(/<[^<>\s]+>/g)) {
      const n = normalizeMessageId(m[0]);
      if (n) ids.push(n);
    }
  }
  // References is oldest→newest; In-Reply-To is the direct parent. Prefer parent, then newest refs.
  const [parent, ...rest] = ids;
  const ordered = parent ? [parent, ...rest.reverse()] : [];
  return [...new Set(ordered)];
}
