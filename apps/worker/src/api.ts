import { type AgentRole, normalizeMessageId, sha256Hex, subjectWithRef, TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "@cf-helpdesk/core";
import { type HelpdeskRepo, TicketConflictError, type TicketFilter, type TicketPatch, withRepo } from "@cf-helpdesk/db";
import { type Context, Hono } from "hono";
import { AccessUnavailableError, type Principal, secretsEqual, verifyAccessJwt } from "./auth";
import { newMessageId, type SendFormat, sendViaBinding } from "./email/outbound";

type AppEnv = { Bindings: Env & { API_TOKEN?: string }; Variables: { principal: Principal } };
type C = Context<AppEnv>;

export const api = new Hono<AppEnv>();

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof TicketConflictError) return c.json({ error: err.message }, 409);
  if (err instanceof AccessUnavailableError) return c.json({ error: "sign-in temporarily unavailable" }, 503);
  console.error(JSON.stringify({ msg: "api error", error: String(err), stack: (err as Error).stack }));
  return c.json({ error: "internal error" }, 500);
});

api.get("/health", (c) => c.json({ ok: true }));

// ---- Authentication --------------------------------------------------------------------------
// 1. Cloudflare Access (people): Access in front of the Worker adds Cf-Access-Jwt-Assertion; we verify
//    it (ACCESS_TEAM_DOMAIN + ACCESS_AUD) and map the email to an active agent.
// 2. API token (automation, bootstrap): `Authorization: Bearer <API_TOKEN>` acts as an admin service.

api.use("/api/*", async (c, next) => {
  const env = c.env;
  const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) {
    if (!env.API_TOKEN || !(await secretsEqual(bearer, env.API_TOKEN))) throw new HttpError(401, "unauthorized");
    c.set("principal", { kind: "service", role: "admin", actor: "api" });
    return next();
  }

  const jwt = c.req.header("cf-access-jwt-assertion") ?? getCookie(c.req.header("cookie"), "CF_Authorization");
  if (jwt && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    // Access credentials ride on a browser cookie, so block cross-site requests that change state (CSRF).
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOrigin(c)) throw new HttpError(403, "cross-site request blocked");
    const claims = await verifyAccessJwt(jwt, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    if (!claims) throw new HttpError(401, "invalid Access token");
    const agent = await withRepo(env, (r) => r.getAgentByEmail(claims.email));
    if (!agent || !agent.active) throw new HttpError(403, `${claims.email} is not an active agent`);
    c.set("principal", { kind: "agent", role: agent.role, actor: `agent:${agent.id}`, agent });
    return next();
  }

  if (!env.API_TOKEN && !(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD)) {
    throw new HttpError(503, "API disabled: set the API_TOKEN secret or configure Cloudflare Access");
  }
  throw new HttpError(401, "unauthorized");
});

const principal = (c: C) => c.get("principal");
function requireAdmin(c: C) {
  if (principal(c).role !== "admin") throw new HttpError(403, "admin only");
}

/** Browsers send Sec-Fetch-Site and/or Origin; tools like curl send neither and are allowed. */
function sameOrigin(c: C): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = c.req.header("origin");
  return !origin || origin === new URL(c.req.url).origin;
}

function getCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(/;\s*/).find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function body<T>(c: C): Promise<Partial<T>> {
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

const str = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return v;
};

async function ticketOr404(repo: HelpdeskRepo, ref: string) {
  const t = await repo.findTicketByRef(ref);
  if (!t) throw new HttpError(404, "ticket not found");
  return t;
}

// ---- Me, agents, mailboxes ---------------------------------------------------------------------

api.get("/api/me", (c) => c.json(principal(c)));

api.get("/api/agents", async (c) => c.json({ agents: await withRepo(c.env, (r) => r.listAgents()) }));

const ROLES: AgentRole[] = ["admin", "agent"];

api.post("/api/agents", async (c) => {
  requireAdmin(c);
  const b = await body<{ email: string; name: string; role: AgentRole }>(c);
  const email = str(b.email, "email", 320);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "email is invalid");
  const role = b.role ?? "agent";
  if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
  const agent = await withRepo(c.env, (r) => r.createAgent({ email, name: str(b.name, "name", 255), role }));
  return c.json(agent, 201);
});

api.patch("/api/agents/:id", async (c) => {
  requireAdmin(c);
  const b = await body<{ name: string; role: AgentRole; active: boolean }>(c);
  if (b.role !== undefined && !ROLES.includes(b.role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
  if (b.active !== undefined && typeof b.active !== "boolean") throw new HttpError(400, "active must be a boolean");
  const me = principal(c).agent;
  const id = c.req.param("id");
  const demoting = b.active === false || b.role === "agent";
  if (me?.id === id && demoting) throw new HttpError(409, "you can't deactivate or demote yourself");
  const agent = await withRepo(c.env, async (r) => {
    const current = await r.getAgent(id);
    if (current && demoting && current.role === "admin" && current.active && (await r.countActiveAdmins()) <= 1) {
      throw new HttpError(409, "can't deactivate or demote the last active admin");
    }
    return r.updateAgent(id, { ...(b.name !== undefined ? { name: str(b.name, "name", 255) } : {}), ...(b.role ? { role: b.role } : {}), ...(b.active !== undefined ? { active: b.active } : {}) });
  });
  return agent ? c.json(agent) : c.json({ error: "agent not found" }, 404);
});

api.get("/api/mailboxes", async (c) => c.json({ mailboxes: await withRepo(c.env, (r) => r.listMailboxes()) }));

api.post("/api/mailboxes", async (c) => {
  requireAdmin(c);
  const b = await body<{ address: string; name: string; refPrefix: string; fromName?: string }>(c);
  if (!b.address?.includes("@") || !/^[A-Z0-9]{2,10}$/i.test(b.refPrefix ?? "")) {
    throw new HttpError(400, "address and refPrefix (2-10 alphanumerics) required");
  }
  const mailbox = await withRepo(c.env, (r) => r.createMailbox({ address: b.address!, name: str(b.name, "name", 255), refPrefix: b.refPrefix!, fromName: b.fromName ?? null }));
  return c.json(mailbox, 201);
});

// ---- Tickets -----------------------------------------------------------------------------------

api.get("/api/tickets", async (c) => {
  const q = c.req.query();
  const n = Number(q.limit ?? 25);
  const filter: TicketFilter = { limit: Number.isFinite(n) ? Math.max(1, Math.min(Math.trunc(n), 100)) : 25 };
  if (q.status) {
    const statuses = q.status.split(",");
    if (statuses.some((s) => !TICKET_STATUSES.includes(s as TicketStatus))) throw new HttpError(400, `status must be among ${TICKET_STATUSES.join(", ")}`);
    filter.statuses = statuses;
  }
  if (q.assignee === "me") {
    const me = principal(c).agent;
    if (!me) throw new HttpError(400, "assignee=me needs an agent login");
    filter.assigneeId = me.id;
  } else if (q.assignee === "unassigned") filter.assigneeId = null;
  else if (q.assignee) filter.assigneeId = q.assignee;
  if (q.category) filter.category = q.category;
  if (q.mailbox) filter.mailboxId = q.mailbox;
  if (q.q) filter.q = q.q.slice(0, 200);
  if (q.cursor) filter.cursor = q.cursor;
  const tickets = await withRepo(c.env, (r) => r.listTickets(filter));
  return c.json({ tickets, nextCursor: tickets.length === filter.limit ? tickets.at(-1)!.id : null });
});

api.get("/api/tickets/:ref", async (c) => {
  const detail = await withRepo(c.env, (r) => r.getTicketDetail(c.req.param("ref")));
  return detail ? c.json(detail) : c.json({ error: "ticket not found" }, 404);
});

api.patch("/api/tickets/:ref", async (c) => {
  const b = await body<{ status: TicketStatus; priority: TicketPriority; assignee: string | null }>(c);
  const patch: TicketPatch = {};
  if (b.status !== undefined) {
    if (!TICKET_STATUSES.includes(b.status)) throw new HttpError(400, `status must be one of ${TICKET_STATUSES.join(", ")}`);
    patch.status = b.status;
  }
  if (b.priority !== undefined) {
    if (!TICKET_PRIORITIES.includes(b.priority)) throw new HttpError(400, `priority must be one of ${TICKET_PRIORITIES.join(", ")}`);
    patch.priority = b.priority;
  }
  const ticket = await withRepo(c.env, async (r) => {
    if (b.assignee !== undefined) {
      if (b.assignee === null) patch.assigneeId = null;
      else {
        const id = b.assignee === "me" ? principal(c).agent?.id : b.assignee;
        if (!id) throw new HttpError(400, "assignee=me needs an agent login");
        const agent = await r.getAgent(id);
        if (!agent || !agent.active) throw new HttpError(400, "assignee must be an active agent");
        patch.assigneeId = agent.id;
      }
    }
    return r.updateTicket(await ticketOr404(r, c.req.param("ref")), patch, principal(c).actor);
  });
  return c.json(ticket);
});

/** Store a body in R2 next to the ticket's mail; returns the key. */
async function storeBody(env: Env, ticketId: string, kind: "note" | "reply", text: string) {
  const key = `tickets/${ticketId}/${kind}s/${crypto.randomUUID()}.txt`;
  await env.MAIL.put(key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return key;
}

const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 500);

api.post("/api/tickets/:ref/notes", async (c) => {
  const b = await body<{ text: string }>(c);
  const text = str(b.text, "text", 50_000);
  const p = principal(c);
  const result = await withRepo(c.env, async (r) => {
    const ticket = await ticketOr404(r, c.req.param("ref"));
    const { messageId } = await r.appendMessage({
      ticket,
      reopen: false,
      actor: p.actor,
      attachments: [],
      message: {
        direction: "note", kind: "note", ingest_key: null, message_id_hdr: null, provider_msg_id: null, in_reply_to: null,
        from_addr: p.agent?.email ?? "api", to_json: "[]", cc_json: null, subject: ticket.subject,
        text_preview: preview(text), text_r2_key: await storeBody(c.env, ticket.id, "note", text), html_r2_key: null, raw_r2_key: null,
        auth_json: null, author_agent_id: p.agent?.id ?? null,
      },
    });
    return r.getMessage(messageId);
  });
  return c.json(result, 201);
});

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Reply to the customer by email, threaded into their conversation. The ticket moves to `status`
 * (default "pending", i.e. waiting on the customer); their next email reopens it.
 * Send `Idempotency-Key` to make retries safe: a repeated key returns the original reply.
 */
api.post("/api/tickets/:ref/replies", async (c) => {
  const b = await body<{ text: string; status: TicketStatus }>(c);
  const text = str(b.text, "text", 50_000);
  const nextStatus = b.status ?? "pending";
  if (!TICKET_STATUSES.includes(nextStatus)) throw new HttpError(400, `status must be one of ${TICKET_STATUSES.join(", ")}`);
  const p = principal(c);
  const idemHeader = c.req.header("idempotency-key");
  if (idemHeader !== undefined && !/^[\w.:-]{1,128}$/.test(idemHeader)) throw new HttpError(400, "Idempotency-Key: 1-128 chars of [A-Za-z0-9_.:-]");

  const out = await withRepo(c.env, async (r) => {
    let ticket = await ticketOr404(r, c.req.param("ref"));
    const mailbox = (await r.listMailboxes()).find((m) => m.id === ticket.mailboxId);
    const requester = await r.getContact(ticket.requesterId);
    if (!mailbox || !requester) throw new HttpError(409, "ticket has no mailbox or requester");
    const thread = await r.getThreading(ticket.id);
    const subject = subjectWithRef(/^re:/i.test(ticket.subject) ? ticket.subject : `Re: ${ticket.subject}`, ticket.ref);
    const ourId = newMessageId(mailbox.address.split("@")[1]!);

    // 1. Reserve the message row first (with the idempotency key). A repeated key returns the
    //    original reply; a crash after sending leaves a recorded reply, never a second email.
    const ingestKey = idemHeader ? await sha256Hex(`reply:${ticket.id}:${idemHeader}`) : null;
    const reserved = await r.reserveOutbound(ticket, {
      direction: "outbound", kind: "agent_reply", ingest_key: ingestKey,
      message_id_hdr: ourId, provider_msg_id: null,
      in_reply_to: thread.inReplyTo, from_addr: mailbox.address, to_json: JSON.stringify([requester.email]), cc_json: null,
      subject, text_preview: preview(text), text_r2_key: await storeBody(c.env, ticket.id, "reply", text),
      html_r2_key: null, raw_r2_key: null, auth_json: null, author_agent_id: p.agent?.id ?? null,
    });
    if (reserved.existing) return { status: 200 as const, message: await r.getMessage(reserved.messageId), ticket };

    // 2. Send. On failure, release the reservation so the agent can retry.
    const fromName = p.agent ? `${p.agent.name} (${mailbox.fromName ?? mailbox.name})` : (mailbox.fromName ?? mailbox.name);
    let providerId: string | null;
    try {
      providerId = (
        await sendViaBinding(
          c.env.EMAIL,
          {
            from: { email: mailbox.address, name: fromName },
            to: { email: requester.email, name: requester.name },
            subject,
            text,
            html: `<div>${escapeHtml(text).replace(/\n/g, "<br>")}</div>`,
            messageId: ourId,
            inReplyTo: thread.inReplyTo,
            references: thread.references,
            ticketRef: ticket.ref,
          },
          (c.env.EMAIL_SEND_FORMAT as SendFormat) || "raw",
        )
      ).providerMessageId;
    } catch (err) {
      await r.discardMessage(reserved.messageId);
      console.error(JSON.stringify({ msg: "reply send failed", ticket: ticket.ref, error: String(err) }));
      throw new HttpError(502, "the email could not be sent; nothing was recorded, so it is safe to retry");
    }

    // 3. Record delivery, then move the ticket to the requested status (fresh read: CAS-safe).
    await r.completeOutbound(ticket, reserved.messageId, providerId ? (normalizeMessageId(providerId) ?? providerId) : null, p.actor);
    ticket = await ticketOr404(r, ticket.ref);
    const updated = await r.updateTicket(ticket, { status: nextStatus }, p.actor);
    return { status: 201 as const, message: await r.getMessage(reserved.messageId), ticket: updated };
  });
  return c.json({ message: out.message, ticket: out.ticket }, out.status);
});

/** Full text of a message, note or reply (bodies live in R2). */
api.get("/api/messages/:id/text", async (c) => {
  const msg = await withRepo(c.env, (r) => r.getMessage(c.req.param("id")));
  if (!msg) throw new HttpError(404, "message not found");
  if (!msg.text_r2_key) return c.text(msg.text_preview ?? "");
  const obj = await c.env.MAIL.get(msg.text_r2_key);
  return c.text(obj ? await obj.text() : (msg.text_preview ?? ""));
});
