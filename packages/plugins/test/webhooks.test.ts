import { describe, expect, it } from "vitest";
import { hmacSha256Hex, verifyWebhookSignature, webhooks } from "../src";
import { eventCtx, fakeFetch } from "./helpers";

type Env = { HOOK_URL?: string; HOOK_SECRET?: string };
const env: Env = { HOOK_URL: "https://ops.example/hooks/helpdesk", HOOK_SECRET: "s3cret" };

const plugin = (f: ReturnType<typeof fakeFetch>, events: string[] | "*" = ["github.issue.created"]) =>
  webhooks<Env>({
    fetch: f.fetch,
    endpoints: [{ name: "ops", url: (e) => e.HOOK_URL, secret: (e) => e.HOOK_SECRET, events }],
  });

describe("webhooks", () => {
  it("POSTs a signed payload without customer contact details", async () => {
    const f = fakeFetch(() => new Response("ok"));
    await plugin(f).onEvent!(eventCtx(env).ctx);

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    expect(url).toBe("https://ops.example/hooks/helpdesk");
    expect(headers["x-helpdesk-event"]).toBe("github.issue.created");
    expect(headers["x-helpdesk-delivery"]).toBe("IHMS-000003:kkk:4:github.issue.created");
    const ts = headers["x-helpdesk-timestamp"]!;
    const sig = headers["x-helpdesk-signature-256"]!;
    expect(sig).toBe(`sha256=${await hmacSha256Hex("s3cret", `${ts}.${body}`)}`);
    expect(init.redirect).toBe("manual");
    expect(await verifyWebhookSignature("s3cret", body, sig, ts)).toBe(true);
    expect(await verifyWebhookSignature("wrong", body, sig, ts)).toBe(false);
    expect(await verifyWebhookSignature("s3cret", body + " ", sig, ts)).toBe(false);
    // Replay of a captured delivery 10 minutes later is rejected.
    expect(await verifyWebhookSignature("s3cret", body, sig, ts, { now: (Number(ts) + 600) * 1000 })).toBe(false);

    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ type: "github.issue.created", ticket: { ref: "IHMS-000003", category: "bug" }, data: { number: 7 } });
    expect(body).not.toMatch(/@|requester|from/);
  });

  it("filters by event type and skips endpoints without a URL", async () => {
    const f = fakeFetch(() => new Response("ok"));
    await plugin(f).onEvent!(eventCtx(env, { type: "ticket.created" }).ctx);
    await plugin(f, "*").onEvent!(eventCtx({}).ctx);
    expect(f.calls).toHaveLength(0);
    await plugin(f, "*").onEvent!(eventCtx(env, { type: "ticket.created" }).ctx);
    expect(f.calls).toHaveLength(1);
  });

  it("records failures (after the step's retries) and 4xx/3xx rejections per endpoint", async () => {
    for (const status of [503, 429]) {
      const c = eventCtx(env);
      await plugin(fakeFetch(() => new Response("", { status }))).onEvent!(c.ctx);
      expect(c.events).toEqual([{ type: "webhook.failed", data: expect.objectContaining({ endpoint: "ops", error: `ops: HTTP ${status}` }) }]);
    }
    for (const status of [410, 302]) {
      const c = eventCtx(env);
      await plugin(fakeFetch(() => new Response("", { status }))).onEvent!(c.ctx);
      expect(c.events).toEqual([{ type: "webhook.rejected", data: { endpoint: "ops", status, eventId: "IHMS-000003:kkk:4:github.issue.created" } }]);
    }
  });

  it("isolates endpoints: one being down doesn't block the others", async () => {
    const f = fakeFetch((url) => new Response("", { status: url.includes("down") ? 503 : 200 }));
    const p = webhooks<Env>({
      fetch: f.fetch,
      endpoints: [
        { name: "down", url: () => "https://down.example/h", events: "*" },
        { name: "up", url: () => "https://up.example/h", events: "*" },
      ],
    });
    const c = eventCtx(env);
    await p.onEvent!(c.ctx);
    expect(f.calls.map((x) => x.url)).toEqual(["https://down.example/h", "https://up.example/h"]);
    expect(c.events.map((e) => e.type)).toEqual(["webhook.failed"]);
  });
});
