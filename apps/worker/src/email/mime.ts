// Tiny RFC 5322 / MIME builder for outbound mail. We build MIME ourselves (instead of the
// structured send() API) so we control Message-ID, In-Reply-To, References and Auto-Submitted.

export interface MimeAddress {
  email: string;
  name?: string | null;
}

export interface MimeInput {
  from: MimeAddress;
  to: MimeAddress[];
  subject: string;
  text: string;
  html?: string | null;
  messageId: string; // "<id@domain>"
  date?: Date;
  headers?: Record<string, string>;
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** RFC 2047 encoded-word for non-ASCII header values. */
export function encodeHeaderValue(v: string): string {
  const clean = v.replace(/[\r\n]+/g, " ");
  return isAscii(clean) ? clean : `=?UTF-8?B?${b64(clean)}?=`;
}

export function formatAddress(a: MimeAddress): string {
  if (!a.name) return a.email;
  const name = isAscii(a.name) ? `"${a.name.replace(/["\\\r\n]/g, "")}"` : encodeHeaderValue(a.name);
  return `${name} <${a.email}>`;
}

const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");

function assertHeaderSafe(name: string, value: string) {
  if (/[\r\n]/.test(value) || !/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`Unsafe header ${name}`);
}

export function buildMime(m: MimeInput): string {
  const boundary = `b_${crypto.randomUUID().replace(/-/g, "")}`;
  const headers: [string, string][] = [
    ["From", formatAddress(m.from)],
    ["To", m.to.map(formatAddress).join(", ")],
    ["Subject", encodeHeaderValue(m.subject)],
    ["Date", (m.date ?? new Date()).toUTCString().replace("GMT", "+0000")],
    ["Message-ID", m.messageId],
    ["MIME-Version", "1.0"],
    ...Object.entries(m.headers ?? {}),
  ];
  for (const [k, v] of headers) assertHeaderSafe(k, v);

  const head = headers.map(([k, v]) => `${k}: ${v}`).join("\r\n");
  const textPart = `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(m.text))}`;
  if (!m.html) return `${head}\r\n${textPart}`;
  const htmlPart = `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(m.html))}`;
  return (
    `${head}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n${textPart}\r\n--${boundary}\r\n${htmlPart}\r\n--${boundary}--\r\n`
  );
}
