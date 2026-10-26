import type { HelpdeskEvent, HelpdeskPlugin, HookContext } from "@rolandihms/helpdesk-core";
import { hmacSha256Hex, safeEqual } from "./crypto";

export interface WebhookEndpoint<Env> {
  /** Stable name; part of the Workflow step name, so don't rename while tickets are in flight. */
  name: string;
  /** Target URL. Return undefined/empty to disable (e.g. env var not set). */
  url: (env: Env) => string | undefined;
  /** Event types to deliver, e.g. ["github.issue.created"], or "*" for all. */
  events: string[] | "*";
  /** Signing secret. When set, requests carry X-Helpdesk-Signature-256. Strongly recommended. */
  secret?: (env: Env) => string | undefined;
  /** Extra static headers (e.g. an API key the receiver expects). */
  headers?: (env: Env) => Record<string, string>;
}

/** JSON body POSTed to receivers. Contains no customer contact details by design. */
export interface WebhookPayload {
  id: string;
  type: string;
  occurredAt: string;
  source: string;
  ticket: {
    id: string;
    ref: string;
    status: string;
    priority: string;
    category: string | null;
    summary: string | null;
  };
  data: Record<string, unknown>;
}

export class WebhookDeliveryError extends Error {}

export function buildPayload(ev: HelpdeskEvent, ticket: HookContext["ticket"]): WebhookPayload {
  return {
    id: ev.id,
    type: ev.type,
    occurredAt: new Date(ev.occurredAt).toISOString(),
    source: ev.source,
    ticket: {
      id: ticket.id,
      ref: ticket.ref,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      summary: ticket.summary,
    },
    data: ev.data,
  };
}

/**
 * Signed outbound webhooks: "trigger another system when X happens" (a GitHub issue was created,
 * a ticket was classified, …). Delivery runs in a Workflow step, so it is retried with backoff on
 * network errors, 5xx, 408 and 429; other non-2xx responses (incl. redirects) are recorded as
 * `webhook.rejected` and not retried; exhausted retries are recorded as `webhook.failed`.
 * Signature: HMAC-SHA256(secret, `${x-helpdesk-timestamp}.${rawBody}`).
 *
 * Receivers should verify `X-Helpdesk-Signature-256` (see verifyWebhookSignature) and dedupe on
 * `X-Helpdesk-Delivery`, because retries and Workflow replays can deliver the same event twice.
 */
export function webhooks<Env>(opts: { name?: string; endpoints: WebhookEndpoint<Env>[]; fetch?: typeof fetch }): HelpdeskPlugin<Env> {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    name: opts.name ?? "webhooks",
    async onEvent(ctx) {
      const ev = ctx.helpdeskEvent;
      for (const ep of opts.endpoints) {
        if (ep.events !== "*" && !ep.events.includes(ev.type)) continue;
        const url = ep.url(ctx.env);
        if (!url) continue;
        // Each endpoint is isolated: one receiver being down never blocks the others.
        try {
          const result = await ctx.step.do(`deliver:${ep.name}`, async () => {
            const body = JSON.stringify(buildPayload(ev, ctx.ticket));
            // Signed inside the step, so the memoised delivery is identical on replay.
            const timestamp = String(Math.floor(Date.now() / 1000));
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "user-agent": "cf-helpdesk-webhooks/1",
              "x-helpdesk-event": ev.type,
              "x-helpdesk-delivery": ev.id,
              "x-helpdesk-timestamp": timestamp,
              ...(ep.headers?.(ctx.env) ?? {}),
            };
            const secret = ep.secret?.(ctx.env);
            if (secret) headers["x-helpdesk-signature-256"] = `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
            else console.warn(JSON.stringify({ msg: "webhook sent unsigned (no secret configured)", endpoint: ep.name }));
            // Never follow redirects: they would re-send the signed body and custom headers elsewhere.
            const res = await doFetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
              throw new WebhookDeliveryError(`${ep.name}: HTTP ${res.status}`); // retried by the step
            }
            return { status: res.status, ok: res.status >= 200 && res.status < 300 };
          });
          if (!result.ok) {
            await ctx.step.do(`deliver:${ep.name}:rejected`, () =>
              ctx.services.addEvent("webhook.rejected", { endpoint: ep.name, status: result.status, eventId: ev.id }),
            );
          }
          ctx.log("webhook delivered", { endpoint: ep.name, type: ev.type, status: result.status });
        } catch (err) {
          await ctx.step.do(`deliver:${ep.name}:failed`, () =>
            ctx.services.addEvent("webhook.failed", { endpoint: ep.name, eventId: ev.id, error: String(err instanceof Error ? err.message : err).slice(0, 300) }),
          );
        }
      }
    },
  };
}

/**
 * For receivers: verify a delivery. Pass the raw request body exactly as received and the
 * `x-helpdesk-signature-256` / `x-helpdesk-timestamp` headers. Rejects timestamps older (or newer)
 * than `toleranceSec` to stop replays; still dedupe on `x-helpdesk-delivery`.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  opts: { toleranceSec?: number; now?: number } = {},
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=") || !timestampHeader || !/^\d{1,12}$/.test(timestampHeader)) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestampHeader)) > (opts.toleranceSec ?? 300)) return false;
  return safeEqual(signatureHeader.slice(7), await hmacSha256Hex(secret, `${timestampHeader}.${rawBody}`));
}
