import { type AgentRole, normalizeMessageId, sha256Hex, subjectWithRef, type Ticket, TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "@cf-helpdesk/core";
import { AgentIdentityConflictError, type HelpdeskRepo, TicketConflictError, type TicketFilter, type TicketPatch, withRepo } from "@cf-helpdesk/db";
import { type Context, Hono } from "hono";
import { AccessUnavailableError, parseTrustedIdentity, type Principal, secretsEqual, verifyAccessJwt } from "./auth";
import { newMessageId, type SendFormat, sendViaBinding } from "./email/outbound";
import type { HelpdeskEnv } from "./env";
import type { HelpdeskOptions } from "./options";
import { type AgentEventsParams, queueAgentEvents } from "./workflow";

type AppEnv = { Bindings: HelpdeskEnv; Variables: { principal: Principal } };
type C = Context<AppEnv>;
type AgentEvents = AgentEventsParams["events"];

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

const principal = (c: C) => c.get("principal");

function requireAdmin(c: C) {
  if (principal(c).role !== "admin") throw new HttpError(403, "admin only");
}

/** Can this caller see records in `partition`? Unrestricted callers see everything. */
const visible = (p: Principal, partition: string | null) => p.partition === null || p.partition === partition;

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

/** A partition from a request body: undefined (not given), null, or a short opaque string. */
function partitionField(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== "string" || !/^[\x21-\x7e]{1,128}$/.test(v)) throw new HttpError(400, "partition: null or 1-128 printable ASCII characters");
  return v;
}

/** The ticket, if it exists and the caller may see it (404 otherwise: never reveal other partitions). */
async function ticketOr404(c: C, repo: HelpdeskRepo, ref: string) {
  const t = await repo.findTicketByRef(ref);
  if (!t || !visible(principal(c), t.partition)) throw new HttpError(404, "ticket not found");
  return t;
}

async function messageOr404(c: C, repo: HelpdeskRepo, id: string) {
  const msg = await repo.getMessage(id);
  const ticket = msg && (await repo.getTicket(msg.ticket_id));
  if (!msg || !ticket || !visible(principal(c), ticket.partition)) throw new HttpError(404, "message not found");
  return msg;
}

/** Store a body in R2 next to the ticket's mail; returns the key. */
async function storeBody(env: HelpdeskEnv, ticketId: string, kind: "note" | "reply", text: string) {
  const key = `tickets/${ticketId}/${kind}s/${crypto.randomUUID()}.txt`;
  await env.MAIL.put(key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return key;
}

const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 500);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const ROLES: AgentRole[] = ["admin", "agent"];

/** One event per field an update changed, for plugins (webhooks…). */
function changeEvents(before: Ticket, after: Ticket, actor: string): AgentEvents {
  const base = { ticketId: after.id, ticketRef: after.ref, actor };
  const at = after.updatedAt;
  const out: AgentEvents = [];
  if (before.status !== after.status) out.push({ type: "ticket.status_changed", occurredAt: at, source: "core", data: { ...base, from: before.status, to: after.status } });
  if (before.priority !== after.priority) out.push({ type: "ticket.priority_changed", occurredAt: at, source: "core", data: { ...base, from: before.priority, to: after.priority } });
  if (before.assigneeId !== after.assigneeId) out.push({ type: "ticket.assigned", occurredAt: at, source: "core", data: { ...base, from: before.assigneeId, to: after.assigneeId } });
  return out;
}

/**
 * The agent REST API (docs/AGENT-API.md). Mounted by createHelpdesk(); the host app can also call it
 * over a service binding with a trusted principal (docs/EMBEDDING.md).
 */
export function createApi(config: HelpdeskOptions) {
  const api = new Hono<AppEnv>();

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof TicketConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof AgentIdentityConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof AccessUnavailableError) return c.json({ error: "sign-in temporarily unavailable" }, 503);
    console.error(JSON.stringify({ msg: "api error", error: String(err), stack: (err as Error).stack }));
    return c.json({ error: "internal error" }, 500);
  });

  api.get("/health", (c) => c.json({ ok: true }));

  // ---- Authentication ------------------------------------------------------------------------
  // 1. Trusted principal (host app over a service binding): X-Helpdesk-Service-Key + X-Helpdesk-Principal.
  //    Off unless TRUSTED_PRINCIPAL=on and HELPDESK_SERVICE_KEY is set.
  // 2. API token (automation, bootstrap): `Authorization: Bearer <API_TOKEN>` acts as an admin service.
  // 3. Cloudflare Access (people): Access in front of the Worker adds Cf-Access-Jwt-Assertion; we verify
  //    it (ACCESS_TEAM_DOMAIN + ACCESS_AUD) and map the email to an active agent.

  api.use("/api/*", async (c, next) => {
    const env = c.env;

    const serviceKey = c.req.header("x-helpdesk-service-key");
    if (serviceKey !== undefined) {
      if (env.TRUSTED_PRINCIPAL !== "on" || !env.HELPDESK_SERVICE_KEY || !(await secretsEqual(serviceKey, env.HELPDESK_SERVICE_KEY))) {
        throw new HttpError(401, "unauthorized");
      }
      const id = parseTrustedIdentity(c.req.header("x-helpdesk-principal"));
      if (typeof id === "string") throw new HttpError(400, id);
      // The host is the source of truth for who this is: provision or re-sync the agent every time.
      const agent = await withRepo(env, (r) => r.upsertAgentByExternalId(id));
      c.set("principal", { kind: "agent", role: agent.role, actor: `agent:${agent.id}`, agent, partition: id.partition, via: "trusted" });
      return next();
    }

    const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      if (!env.API_TOKEN || !(await secretsEqual(bearer, env.API_TOKEN))) throw new HttpError(401, "unauthorized");
      c.set("principal", { kind: "service", role: "admin", actor: "api", partition: null, via: "token" });
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
      c.set("principal", { kind: "agent", role: agent.role, actor: `agent:${agent.id}`, agent, partition: agent.partition, via: "access" });
      return next();
    }

    if (!env.API_TOKEN && !(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) && env.TRUSTED_PRINCIPAL !== "on") {
      throw new HttpError(503, "API disabled: set the API_TOKEN secret, configure Cloudflare Access, or enable TRUSTED_PRINCIPAL");
    }
    throw new HttpError(401, "unauthorized");
  });

  // ---- Me, agents, mailboxes -------------------------------------------------------------------

  api.get("/api/me", (c) => c.json(principal(c)));

  api.get("/api/agents", async (c) => {
    const p = principal(c);
    return c.json({ agents: await withRepo(c.env, (r) => r.listAgents(p.partition === null ? {} : { partition: p.partition })) });
  });

  api.post("/api/agents", async (c) => {
    requireAdmin(c);
    const p = principal(c);
    const b = await body<{ email: string; name: string; role: AgentRole; partition: string | null }>(c);
    const email = str(b.email, "email", 320);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "email is invalid");
    const role = b.role ?? "agent";
    if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
    // A partition-restricted admin can only create agents in its own partition.
    const partition = p.partition ?? partitionField(b.partition) ?? null;
    const agent = await withRepo(c.env, (r) => r.createAgent({ email, name: str(b.name, "name", 255), role, partition }));
    return c.json(agent, 201);
  });

  api.patch("/api/agents/:id", async (c) => {
    requireAdmin(c);
    const p = principal(c);
    const b = await body<{ name: string; role: AgentRole; active: boolean; partition: string | null }>(c);
    if (b.role !== undefined && !ROLES.includes(b.role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
    if (b.active !== undefined && typeof b.active !== "boolean") throw new HttpError(400, "active must be a boolean");
    const partition = partitionField(b.partition);
    if (partition !== undefined && p.partition !== null) throw new HttpError(403, "only unrestricted admins can change an agent's partition");
    const id = c.req.param("id");
    const demoting = b.active === false || b.role === "agent";
    if (p.agent?.id === id && demoting) throw new HttpError(409, "you can't deactivate or demote yourself");
    const agent = await withRepo(c.env, async (r) => {
      const current = await r.getAgent(id);
      // Restricted admins manage only their own partition's agents (not global ones).
      if (!current || (p.partition !== null && current.partition !== p.partition)) return null;
      if (demoting && current.role === "admin" && current.active && (await r.countActiveAdmins()) <= 1) {
        throw new HttpError(409, "can't deactivate or demote the last active admin");
      }
      return r.updateAgent(id, {
        ...(b.name !== undefined ? { name: str(b.name, "name", 255) } : {}),
        ...(b.role ? { role: b.role } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
        ...(partition !== undefined ? { partition } : {}),
      });
    });
    return agent ? c.json(agent) : c.json({ error: "agent not found" }, 404);
  });

  api.get("/api/mailboxes", async (c) => {
    const p = principal(c);
    return c.json({ mailboxes: await withRepo(c.env, (r) => r.listMailboxes(p.partition === null ? {} : { partition: p.partition })) });
  });

  api.post("/api/mailboxes", async (c) => {
    requireAdmin(c);
    const p = principal(c);
    const b = await body<{ address: string; name: string; refPrefix: string; fromName?: string; partition: string | null }>(c);
    if (!b.address?.includes("@") || !/^[A-Z0-9]{2,10}$/i.test(b.refPrefix ?? "")) {
      throw new HttpError(400, "address and refPrefix (2-10 alphanumerics) required");
    }
    const partition = p.partition ?? partitionField(b.partition) ?? null;
    const mailbox = await withRepo(c.env, async (r) => {
      const existing = await r.getMailboxByAddress(b.address!);
      if (existing && !visible(p, existing.partition)) throw new HttpError(409, "address is already in use");
      return r.createMailbox({ address: b.address!, name: str(b.name, "name", 255), refPrefix: b.refPrefix!, fromName: b.fromName ?? null, partition });
    });
    return c.json(mailbox, 201);
  });

  // ---- Tickets ---------------------------------------------------------------------------------

  api.get("/api/tickets", async (c) => {
    const q = c.req.query();
    const p = principal(c);
    const n = Number(q.limit ?? 25);
    const filter: TicketFilter = { limit: Number.isFinite(n) ? Math.max(1, Math.min(Math.trunc(n), 100)) : 25 };
    if (q.status) {
      const statuses = q.status.split(",");
      if (statuses.some((s) => !TICKET_STATUSES.includes(s as TicketStatus))) throw new HttpError(400, `status must be among ${TICKET_STATUSES.join(", ")}`);
      filter.statuses = statuses;
    }
    if (q.assignee === "me") {
      if (!p.agent) throw new HttpError(400, "assignee=me needs an agent login");
      filter.assigneeId = p.agent.id;
    } else if (q.assignee === "unassigned") filter.assigneeId = null;
    else if (q.assignee) filter.assigneeId = q.assignee;
    if (q.category) filter.category = q.category;
    if (q.mailbox) filter.mailboxId = q.mailbox;
    if (q.q) filter.q = q.q.slice(0, 200);
    if (q.cursor) filter.cursor = q.cursor;
    // Restricted callers always see only their partition; unrestricted ones may narrow to one.
    if (p.partition !== null) filter.partition = p.partition;
    else if (q.partition) filter.partition = partitionField(q.partition)!;
    const tickets = await withRepo(c.env, (r) => r.listTickets(filter));
    return c.json({ tickets, nextCursor: tickets.length === filter.limit ? tickets.at(-1)!.id : null });
  });

  api.get("/api/tickets/:ref", async (c) => {
    const detail = await withRepo(c.env, (r) => r.getTicketDetail(c.req.param("ref")));
    if (!detail || !visible(principal(c), detail.ticket.partition)) return c.json({ error: "ticket not found" }, 404);
    // R2 keys are internal; bodies and files are served by the endpoints below.
    const attachments = detail.attachments.map(({ r2_key: _key, ...a }) => a);
    return c.json({ ...detail, attachments });
  });

  api.patch("/api/tickets/:ref", async (c) => {
    const b = await body<{ status: TicketStatus; priority: TicketPriority; assignee: string | null }>(c);
    const p = principal(c);
    const patch: TicketPatch = {};
    if (b.status !== undefined) {
      if (!TICKET_STATUSES.includes(b.status)) throw new HttpError(400, `status must be one of ${TICKET_STATUSES.join(", ")}`);
      patch.status = b.status;
    }
    if (b.priority !== undefined) {
      if (!TICKET_PRIORITIES.includes(b.priority)) throw new HttpError(400, `priority must be one of ${TICKET_PRIORITIES.join(", ")}`);
      patch.priority = b.priority;
    }
    const { before, after } = await withRepo(c.env, async (r) => {
      const ticket = await ticketOr404(c, r, c.req.param("ref"));
      if (b.assignee !== undefined) {
        if (b.assignee === null) patch.assigneeId = null;
        else {
          const id = b.assignee === "me" ? p.agent?.id : b.assignee;
          if (!id) throw new HttpError(400, "assignee=me needs an agent login");
          const agent = await r.getAgent(id);
          // The assignee must be able to work this ticket: global, or in the ticket's partition.
          if (!agent || !agent.active || (agent.partition !== null && agent.partition !== ticket.partition)) {
            throw new HttpError(400, "assignee must be an active agent who can see this ticket");
          }
          patch.assigneeId = agent.id;
        }
      }
      return { before: ticket, after: await r.updateTicket(ticket, patch, p.actor) };
    });
    await queueAgentEvents(config, c.env, after.id, changeEvents(before, after, p.actor));
    return c.json(after);
  });

  api.post("/api/tickets/:ref/notes", async (c) => {
    const b = await body<{ text: string }>(c);
    const text = str(b.text, "text", 50_000);
    const p = principal(c);
    const { ticket, note } = await withRepo(c.env, async (r) => {
      const ticket = await ticketOr404(c, r, c.req.param("ref"));
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
      return { ticket, note: (await r.getMessage(messageId))! };
    });
    await queueAgentEvents(config, c.env, ticket.id, [
      { type: "ticket.note_added", occurredAt: Number(note.created_at), source: "core", data: { ticketId: ticket.id, ticketRef: ticket.ref, actor: p.actor, messageId: note.id } },
    ]);
    return c.json(note, 201);
  });

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
      let ticket = await ticketOr404(c, r, c.req.param("ref"));
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
      if (reserved.existing) return { status: 200 as const, message: (await r.getMessage(reserved.messageId))!, before: ticket, ticket };

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
      ticket = await ticketOr404(c, r, ticket.ref);
      const updated = await r.updateTicket(ticket, { status: nextStatus }, p.actor);
      return { status: 201 as const, message: (await r.getMessage(reserved.messageId))!, before: ticket, ticket: updated };
    });
    if (out.status === 201) {
      const data = { ticketId: out.ticket.id, ticketRef: out.ticket.ref, actor: p.actor, messageId: out.message.id };
      await queueAgentEvents(config, c.env, out.ticket.id, [
        { type: "ticket.replied", occurredAt: Number(out.message.created_at), source: "core", data },
        ...changeEvents(out.before, out.ticket, p.actor),
      ]);
    }
    return c.json({ message: out.message, ticket: out.ticket }, out.status);
  });

  /** Full text of a message, note or reply (bodies live in R2). */
  api.get("/api/messages/:id/text", async (c) => {
    const msg = await withRepo(c.env, (r) => messageOr404(c, r, c.req.param("id")));
    if (!msg.text_r2_key) return c.text(msg.text_preview ?? "");
    const obj = await c.env.MAIL.get(msg.text_r2_key);
    return c.text(obj ? await obj.text() : (msg.text_preview ?? ""));
  });

  /**
   * Download an attachment. Always served as a download (never rendered inline) with nosniff and a
   * sandboxing CSP, so a hostile HTML/SVG attachment can't run script on this origin.
   */
  api.get("/api/attachments/:id", async (c) => {
    const att = await withRepo(c.env, async (r) => {
      const a = await r.getAttachment(c.req.param("id"));
      if (!a) throw new HttpError(404, "attachment not found");
      await messageOr404(c, r, a.message_id);
      return a;
    });
    const obj = await c.env.MAIL.get(att.r2_key);
    if (!obj) throw new HttpError(404, "attachment not found");
    const name = (att.filename ?? "attachment").replace(/[\x00-\x1f"\\/]/g, "_").slice(0, 200);
    return new Response(obj.body, {
      headers: {
        "content-type": /^[\w.+-]+\/[\w.+-]+$/.test(att.mime_type) ? att.mime_type : "application/octet-stream",
        "content-length": String(obj.size),
        "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  });

  return api;
}
