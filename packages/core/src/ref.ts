/** Ticket refs look like `ACME-000123`. Prefix is per mailbox. */
export function formatRef(prefix: string, n: number, width = 6): string {
  return `${prefix}-${String(n).padStart(width, "0")}`;
}

/** Find `[PREFIX-000123]` tokens in a subject. Only bracketed tokens count, to avoid false positives. */
export function findRefsInSubject(subject: string, prefix: string): string[] {
  const p = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[(${p}-\\d{1,12})\\]`, "gi");
  return [...subject.matchAll(re)].map((m) => m[1]!.toUpperCase());
}

export function subjectWithRef(subject: string, ref: string): string {
  const clean = subject.trim() || "(no subject)";
  return clean.includes(`[${ref}]`) ? clean : `[${ref}] ${clean}`;
}
