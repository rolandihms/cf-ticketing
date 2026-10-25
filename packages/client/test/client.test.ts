import { describe, expect, it } from "vitest";
import { createHelpdeskClient, HelpdeskApiError } from "../src";
import { forwardToHelpdesk, trustedHeaders } from "../src/server";

function recorder(respond: (r: Request) => Response | Promise<Response> = () => Response.json({})) {
  const seen: Request[] = [];
  return { seen, fetch: async (r: Request) => (seen.push(r), respond(r)) };
}

describe("createHelpdeskClient", () => {
  it("builds URLs, query strings and JSON bodies", async () => {
    const f = recorder(() => Response.json({ tickets: [], nextCursor: null }));
    const hd = createHelpdeskClient({ baseUrl: "https://app.test/api/v1/helpdesk/", fetch: f.fetch, headers: () => ({ "x-app": "1" }) });
    await hd.tickets.list({ status: ["open", "pending"], assignee: "me", q: "", limit: 10 });
    expect(f.seen[0]!.url).toBe("https://app.test/api/v1/helpdesk/tickets?status=open%2Cpending&assignee=me&limit=10");
    expect(f.seen[0]!.headers.get("x-app")).toBe("1");

    await hd.tickets.reply("ACME-000001", { text: "Hi", idempotencyKey: "k1" });
    const r = f.seen[1]!;
    expect([r.method, r.url, r.headers.get("content-type"), r.headers.get("idempotency-key")]).toEqual([
      "POST", "https://app.test/api/v1/helpdesk/tickets/ACME-000001/replies", "application/json", "k1",
    ]);
    expect(await r.json()).toEqual({ text: "Hi" });
    expect(hd.attachments.url("01A/B")).toBe("https://app.test/api/v1/helpdesk/attachments/01A%2FB");
  });

  it("throws HelpdeskApiError with the API's status and message", async () => {
    const hd = createHelpdeskClient({ baseUrl: "https://hd.test/api", fetch: async () => Response.json({ error: "ticket not found" }, { status: 404 }) });
    const err = await hd.tickets.get("X-1").catch((e) => e);
    expect(err).toBeInstanceOf(HelpdeskApiError);
    expect([err.status, err.message]).toEqual([404, "ticket not found"]);
  });
});

describe("forwardToHelpdesk", () => {
  const identity = { externalId: "u1", email: "kim@host.test", name: "Kim", role: "agent" as const, partition: "company:1" };

  it("maps the mount path to /api, sets the trusted headers and drops client-supplied credentials", async () => {
    const f = recorder(() => new Response("ok", { headers: { "set-cookie": "x=1", "x-other": "y" } }));
    const req = new Request("https://app.test/api/v1/helpdesk/tickets/ACME-1/notes?x=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session=secret",
        authorization: "Bearer stolen",
        "x-helpdesk-principal": '{"role":"admin","partition":null}',
        "x-helpdesk-service-key": "guess",
        "cf-access-jwt-assertion": "jwt",
        connection: "keep-alive",
      },
      body: '{"text":"hi"}',
    });
    const res = await forwardToHelpdesk(req, { target: f, serviceKey: "svc", identity, mountPath: "/api/v1/helpdesk/" });
    const out = f.seen[0]!;
    expect(out.url).toBe("https://helpdesk.internal/api/tickets/ACME-1/notes?x=1");
    expect(out.headers.get("x-helpdesk-service-key")).toBe("svc");
    expect(JSON.parse(out.headers.get("x-helpdesk-principal")!)).toEqual(identity);
    for (const h of ["cookie", "authorization", "cf-access-jwt-assertion", "connection"]) expect(out.headers.get(h)).toBeNull();
    expect(await out.text()).toBe('{"text":"hi"}');
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-other")).toBe("y");
  });

  it("refuses paths outside the mount and requires an explicit partition", async () => {
    const f = recorder();
    expect((await forwardToHelpdesk(new Request("https://app.test/api/v1/other"), { target: f, serviceKey: "s", identity, mountPath: "/api/v1/helpdesk" })).status).toBe(404);
    expect((await forwardToHelpdesk(new Request("https://app.test/api/v1/helpdesk-evil/x"), { target: f, serviceKey: "s", identity, mountPath: "/api/v1/helpdesk" })).status).toBe(404);
    expect(f.seen).toHaveLength(0);
    const { partition: _p, ...noPartition } = identity;
    expect(() => trustedHeaders("s", noPartition as never)).toThrow(/partition is required/);
    expect(() => trustedHeaders("", identity)).toThrow(/serviceKey/);
  });
});
