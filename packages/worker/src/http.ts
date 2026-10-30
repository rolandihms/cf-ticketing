// Request helpers shared by the staff API (api.ts) and the requester API (requester.ts).
import type { MessagesTable } from "@rolandihms/helpdesk-db";
import type { Context } from "hono";
import type { Principal } from "./auth";
import type { HelpdeskEnv } from "./env";

export type AppEnv = { Bindings: HelpdeskEnv; Variables: { principal: Principal } };
export type C = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

export async function body<T>(c: C): Promise<Partial<T>> {
  // JSON only: an HTML form can't send application/json cross-site without a CORS preflight.
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
  try {
    const b = await c.req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b as Partial<T>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

export const str = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return v;
};

/** Text that ends up in a mail header (display names): required, ≤255 characters, no control characters. */
export const headerText = (v: unknown, field: string): string => {
  const t = str(v, field, 255);
  if (/[\x00-\x1f\x7f]/.test(t)) throw new HttpError(400, `${field} must not contain control characters`);
  return t;
};

/** A partition from a request body: undefined (not given), null, or a short opaque string. */
export function partitionField(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== "string" || !/^[\x21-\x7e]{1,128}$/.test(v)) throw new HttpError(400, "partition: null or 1-128 printable ASCII characters");
  return v;
}

/** Store a body in R2 next to the ticket's mail; returns the key. */
export async function storeBody(env: HelpdeskEnv, ticketId: string, kind: "note" | "reply" | "message", text: string) {
  const key = `tickets/${ticketId}/${kind}s/${crypto.randomUUID()}.txt`;
  await env.MAIL.put(key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return key;
}

export const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 500);

/** An Idempotency-Key header, validated; undefined when absent. */
export function idempotencyKey(c: C): string | undefined {
  const v = c.req.header("idempotency-key");
  if (v !== undefined && !/^[\w.:-]{1,128}$/.test(v)) throw new HttpError(400, "Idempotency-Key: 1-128 chars of [A-Za-z0-9_.:-]");
  return v;
}

const META_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Ticket metadata from a request body: an object of ≤20 string values, keys 1-64 of [A-Za-z0-9_.:-], values ≤200 chars. */
export function metadataField(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "metadata must be an object of strings");
  const entries = Object.entries(v);
  if (entries.length > 20) throw new HttpError(400, "metadata allows at most 20 keys");
  for (const [k, val] of entries) {
    if (!META_KEY_RE.test(k)) throw new HttpError(400, `metadata key "${k.slice(0, 64)}": 1-64 chars of [A-Za-z0-9_.:-]`);
    if (typeof val !== "string" || val.length > 200 || /[\x00-\x1f\x7f]/.test(val)) throw new HttpError(400, `metadata.${k}: a string up to 200 characters, no control characters`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** For inbound mail: whether DMARC proved the From address (portal/app messages: true). null when unknown. */
export function senderVerifiedOf(m: MessagesTable): boolean | null {
  if (m.direction !== "inbound" || !m.auth_json) return null;
  try {
    const v = (JSON.parse(m.auth_json) as { senderVerified?: unknown }).senderVerified;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}
