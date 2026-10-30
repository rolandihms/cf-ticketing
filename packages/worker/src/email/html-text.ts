const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Plain text from an HTML-only email, for the preview, the full-text endpoint and the classifier.
 * Readability, not fidelity: drops head/script/style, keeps block breaks and link targets, decodes entities.
 * The output is only ever served as text/plain or JSON, so it never needs to be safe HTML.
 */
export function htmlToText(html: string): string {
  const fromCode = (n: number) => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "");
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|script|style|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*["']?(https?:[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, label: string) =>
      label.replace(/<[^>]*>/g, "").trim() === href ? href : `${label} (${href})`,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|ul|ol|h[1-6]|blockquote|table|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#" ? fromCode(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
