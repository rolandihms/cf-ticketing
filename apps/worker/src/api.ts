import { Hono } from "hono";
import { createRepo, D1Repo } from "./db/repo";

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  return ea.byteLength === eb.byteLength && crypto.subtle.timingSafeEqual(ea, eb);
}

type AppEnv = { Bindings: Env & { API_TOKEN?: string } };

export const api = new Hono<AppEnv>();

api.get("/health", (c) => c.json({ ok: true }));

// Phase 1: a static bearer token (`wrangler secret put API_TOKEN`). Phase 2 adds Cloudflare Access.
api.use("/api/*", async (c, next) => {
  const token = c.env.API_TOKEN;
  if (!token) return c.json({ error: "API disabled: set the API_TOKEN secret" }, 503);
  const header = c.req.header("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(given, token)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

api.get("/api/tickets", async (c) => {
  const repo = createRepo(c.env);
  const tickets = await repo.listTickets({
    status: c.req.query("status"),
    limit: Number(c.req.query("limit") ?? 25),
    cursor: c.req.query("cursor"),
  });
  return c.json({ tickets, nextCursor: tickets.length ? tickets[tickets.length - 1]!.id : null });
});

api.get("/api/tickets/:ref", async (c) => {
  const repo = new D1Repo(c.env.DB);
  const ticket = await repo.findTicketByRef(c.req.param("ref"));
  if (!ticket) return c.json({ error: "not found" }, 404);
  const [messages, events, requester] = await Promise.all([
    repo.db.selectFrom("messages").selectAll().where("ticket_id", "=", ticket.id).orderBy("created_at").execute(),
    repo.db.selectFrom("ticket_events").selectAll().where("ticket_id", "=", ticket.id).orderBy("created_at").execute(),
    repo.getContact(ticket.requesterId),
  ]);
  return c.json({ ticket, requester, messages, events });
});

api.post("/api/mailboxes", async (c) => {
  const body = await c.req.json<{ address: string; name: string; refPrefix: string; fromName?: string }>();
  if (!body.address?.includes("@") || !/^[A-Z0-9]{2,10}$/i.test(body.refPrefix ?? "")) {
    return c.json({ error: "address and refPrefix (2-10 alphanumerics) required" }, 400);
  }
  return c.json(await createRepo(c.env).createMailbox(body), 201);
});
