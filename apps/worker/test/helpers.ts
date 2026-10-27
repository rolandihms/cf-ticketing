import { vi } from "vitest";

export function rawEmail(o: {
  from: string;
  to: string;
  subject: string;
  body?: string;
  contentType?: string;
  messageId?: string | null;
  headers?: Record<string, string>;
  /** Email Routing's verdict header, topmost; null leaves it out. Default: dmarc=pass. */
  authResults?: string | null;
}): string {
  const auth = o.authResults === undefined ? "mx.cloudflare.net; dkim=pass header.d=cust.example; dmarc=pass header.from=cust.example" : o.authResults;
  const lines = [
    ...(auth === null ? [] : [`Authentication-Results: ${auth}`]),
    `From: Jane Customer <${o.from}>`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Date: Tue, 14 Oct 2026 10:00:00 +0000`,
    ...(o.messageId === null ? [] : [`Message-ID: ${o.messageId ?? `<${crypto.randomUUID()}@cust.example>`}`]),
    ...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    `Content-Type: ${o.contentType ?? "text/plain; charset=utf-8"}`,
    ``,
    o.body ?? "My printer is on fire.",
  ];
  return lines.join("\r\n");
}

/** Minimal ForwardableEmailMessage for driving the email() handler in tests. */
export function inboundMessage(from: string, to: string, raw: string) {
  const bytes = new TextEncoder().encode(raw);
  const headerBlock = raw.split("\r\n\r\n")[0]!;
  const headers = new Headers();
  for (const line of headerBlock.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.append(line.slice(0, i), line.slice(i + 1).trim());
  }
  return {
    from,
    to,
    headers,
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(async () => ({ messageId: "reply-id" })),
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
}
