import { type Agent, type AgentRole, normalizeMessageId, sha256Hex, subjectWithRef, type Ticket, TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "@rolandihms/helpdesk-core";
import { AgentIdentityConflictError, ContactIdentityConflictError, type HelpdeskRepo, type MessagesTable, TicketConflictError, type TicketFilter, type TicketPatch, withRepo } from "@rolandihms/helpdesk-db";
import { type Context, Hono } from "hono";
import { AccessUnavailableError, parseTrustedIdentity, type Principal, type RequesterPrincipal, secretsEqual, type StaffPrincipal, verifyAccessJwt } from "./auth";
import { newMessageId, type SendFormat, sendViaBinding } from "./email/outbound";
import type { HelpdeskEnv } from "./env";
import type { HelpdeskOptions } from "./options";
import { type AppEnv, body, type C, headerText, HttpError, idempotencyKey, metadataField, partitionField, preview, senderVerifiedOf, storeBody, str } from "./http";
import * as requester from "./requester";
import { type AgentEventsParams, queueAgentEvents } from "./workflow";

/** Mailbox addresses go into From/To headers of every ack and reply: keep them to plain, header-safe addresses. */
const MAILBOX_ADDRESS_RE = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

type AgentEvents = AgentEventsParams["events"];


const principal = (c: C) => c.get("principal");

/** The caller, who must be staff (an agent, admin or service). Requesters get 403. */
function staff(c: C): StaffPrincipal {
  const p = principal(c);
  if (p.kind === "requester") throw new HttpError(403, "not available to requesters");
  return p;
}

function requireAdmin(c: C) {
  if (staff(c).role !== "admin") throw new HttpError(403, "admin only");
}

/** Can this caller see records in `partition`? Unrestricted callers see everything. */
const visible = (p: StaffPrincipal, partition: string | null) => p.partition === null || p.partition === partition;

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





/** New-ticket notification recipients: plain addresses (they become To headers), lowercased, unique, at most 10. */
function notifyList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, "notifyNewTicket must be an array of email addresses");
  const out = [...new Set(v.map((a) => (typeof a === "string" ? a.trim().toLowerCase() : "")))];
  if (out.length > 10) throw new HttpError(400, "notifyNewTicket allows at most 10 addresses");
  const bad = out.find((a) => !MAILBOX_ADDRESS_RE.test(a));
  if (bad !== undefined) throw new HttpError(400, `notifyNewTicket: ${bad ? `"${bad}"` : "an entry"} is not a plain email address`);
  return out;
}

/**
 * A message as the API returns it. An allowlist: R2 keys, the ingest key and the raw auth record stay internal.
 * sender_verified: for inbound mail, whether DMARC proved the From address (null for our own messages and old rows).
 */
function publicMessage(m: MessagesTable) {
  const senderVerified = senderVerifiedOf(m);
  return {
    id: m.id, ticket_id: m.ticket_id, mailbox_id: m.mailbox_id, direction: m.direction, kind: m.kind,
    message_id_hdr: m.message_id_hdr, provider_msg_id: m.provider_msg_id, in_reply_to: m.in_reply_to,
    from_addr: m.from_addr, to_json: m.to_json, cc_json: m.cc_json, subject: m.subject, text_preview: m.text_preview,
    author_agent_id: m.author_agent_id, author_contact_id: m.author_contact_id, created_at: m.created_at, sender_verified: senderVerified,
  };
}


/** The ticket, if it exists and the caller may see it (404 otherwise: never reveal other partitions). */
async function ticketOr404(c: C, repo: HelpdeskRepo, ref: string) {
  const t = await repo.findTicketByRef(ref);
  if (!t || !visible(staff(c), t.partition)) throw new HttpError(404, "ticket not found");
  return t;
}

async function messageOr404(c: C, repo: HelpdeskRepo, id: string) {
  const msg = await repo.getMessage(id);
  const ticket = msg && (await repo.getTicket(msg.ticket_id));
  if (!msg || !ticket || !visible(staff(c), ticket.partition)) throw new HttpError(404, "message not found");
  return msg;
}


/**
 * Can this agent work tickets in `partition`? Restricted agents: only their own. Host-provisioned
 * agents: partitions the host has sent them with ("*" = all). Other global agents: everywhere.
 */
async function canWork(repo: HelpdeskRepo, agent: Agent, partition: string | null) {
  if (agent.partition !== null) return agent.partition === partition;
  if (agent.externalId === null) return true;
  const seen = await repo.getAgentPartitions(agent.id);
  return seen.includes("*") || (partition !== null && seen.includes(partition));
}

/** RFC 5987 value: encodeURIComponent leaves ' ( ) * ! unencoded, which aren't attr-chars. */
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
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
    if (err instanceof ContactIdentityConflictError) return c.json({ error: err.message }, 409);
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
      if (id.role === "requester") {
        // A customer: a contact, never an agent (so staff who also raise tickets don't collide).
        const contact = await withRepo(env, (r) => r.upsertContactByExternalId(id));
        if (!requester.allows(c.req.method, new URL(c.req.url).pathname)) throw new HttpError(403, "not available to requesters");
        c.set("principal", { kind: "requester", role: "requester", actor: `contact:${contact.id}`, contact, partition: id.partition, visibility: id.visibility ?? "own", via: "trusted" });
        return next();
      }
      // The host is the source of truth for who this is: provision or re-sync the agent every time.
      const role = id.role;
      const agent = await withRepo(env, (r) => r.upsertAgentByExternalId({ externalId: id.externalId, email: id.email, name: id.name, role, partition: id.partition }));
      // (The upsert also records that this agent works in id.partition; see canWork.)
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
      // Host-provisioned agents get their partition from the host per request; they sign in there.
      if (agent.externalId) throw new HttpError(403, `${claims.email} signs in through the host application`);
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
    const p = staff(c);
    return c.json({ agents: await withRepo(c.env, (r) => r.listAgents(p.partition === null ? {} : { partition: p.partition })) });
  });

  api.post("/api/agents", async (c) => {
    requireAdmin(c);
    const p = staff(c);
    const b = await body<{ email: string; name: string; role: AgentRole; partition: string | null }>(c);
    const email = str(b.email, "email", 320);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "email is invalid");
    const role = b.role ?? "agent";
    if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
    // A partition-restricted admin can only create agents in its own partition.
    const partition = p.partition ?? partitionField(b.partition) ?? null;
    const { agent, created } = await withRepo(c.env, async (r) => {
      const existing = await r.getAgentByEmail(email);
      // Idempotent for the same caller's agents; never return (or reveal details of) someone else's.
      if (existing) {
        if (!visible(p, existing.partition) || (p.partition !== null && existing.partition === null)) throw new HttpError(409, "email is already in use");
        return { agent: existing, created: false };
      }
      return { agent: await r.createAgent({ email, name: str(b.name, "name", 255), role, partition }), created: true };
    });
    return c.json(agent, created ? 201 : 200);
  });

  api.patch("/api/agents/:id", async (c) => {
    requireAdmin(c);
    const p = staff(c);
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
    const p = staff(c);
    return c.json({ mailboxes: await withRepo(c.env, (r) => r.listMailboxes(p.partition === null ? {} : { partition: p.partition })) });
  });

  api.post("/api/mailboxes", async (c) => {
    requireAdmin(c);
    const p = staff(c);
    // A mailbox decides which tenant an address's mail lands in, so only an unrestricted admin (the operator) adds one.
    if (p.partition !== null) throw new HttpError(403, "only an unrestricted admin can add mailboxes");
    const b = await body<{ address: string; name: string; refPrefix: string; fromName?: string | null; partition: string | null }>(c);
    const address = str(b.address, "address", 254).trim().toLowerCase();
    if (!MAILBOX_ADDRESS_RE.test(address)) throw new HttpError(400, "address must be a plain email address (local@domain.tld)");
    if (!/^[A-Z0-9]{2,10}$/i.test(b.refPrefix ?? "")) throw new HttpError(400, "refPrefix must be 2-10 alphanumerics");
    const name = headerText(b.name, "name");
    const fromName = b.fromName === undefined || b.fromName === null ? null : headerText(b.fromName, "fromName");
    const partition = partitionField(b.partition) ?? null;
    const mailbox = await withRepo(c.env, async (r) => {
      const existing = await r.getMailboxByAddress(address);
      if (existing && existing.partition !== partition) throw new HttpError(409, "address is already in use");
      return r.createMailbox({ address, name, refPrefix: b.refPrefix!, fromName, partition });
    });
    return c.json(mailbox, 201);
  });

  api.patch("/api/mailboxes/:id", async (c) => {
    requireAdmin(c);
    const p = staff(c);
    const b = await body<{ name: string; fromName: string | null; notifyNewTicket: string[] }>(c);
    const notify = b.notifyNewTicket === undefined ? undefined : notifyList(b.notifyNewTicket);
    const mailbox = await withRepo(c.env, async (r) => {
      const current = await r.getMailbox(c.req.param("id"));
      // Restricted admins manage only their own partition's mailboxes.
      if (!current || !visible(p, current.partition) || (p.partition !== null && current.partition === null)) return null;
      if (notify) {
        // Notifying a help desk address would open a ticket per notification.
        const own = new Set(await r.listMailboxAddresses());
        const loop = notify.find((a) => own.has(a));
        if (loop) throw new HttpError(400, `${loop} is a help desk mailbox; notify a person's address instead`);
      }
      return r.updateMailbox(current.id, {
        ...(b.name !== undefined ? { name: headerText(b.name, "name") } : {}),
        ...(b.fromName !== undefined ? { fromName: b.fromName === null || b.fromName === "" ? null : headerText(b.fromName, "fromName") } : {}),
        ...(notify ? { notifyNewTicket: notify } : {}),
      });
    });
    return mailbox ? c.json(mailbox) : c.json({ error: "mailbox not found" }, 404);
  });

  // ---- Tickets ---------------------------------------------------------------------------------

  api.get("/api/tickets", async (c) => {
    const who = principal(c);
    if (who.kind === "requester") return requester.listTickets(c, who);
    const q = c.req.query();
    const p = staff(c);
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

  /** Raise a ticket from the host app: a requester for itself, or staff on a customer's behalf (requester.ts). */
  api.post("/api/tickets", (c) => requester.createTicket(c, principal(c)));

  /** A requester's reply from the host app (requester.ts). Staff reply by email with /replies. */
  api.post("/api/tickets/:ref/messages", (c) => {
    const who = principal(c);
    if (who.kind !== "requester") throw new HttpError(403, "staff reply with POST /api/tickets/:ref/replies");
    return requester.postMessage(c, who, c.req.param("ref"));
  });

  api.get("/api/tickets/:ref", async (c) => {
    const who = principal(c);
    if (who.kind === "requester") return requester.getTicket(c, who, c.req.param("ref"));
    const detail = await withRepo(c.env, (r) => r.getTicketDetail(c.req.param("ref")));
    if (!detail || !visible(who, detail.ticket.partition)) return c.json({ error: "ticket not found" }, 404);
    // R2 keys are internal; bodies and files are served by the endpoints below.
    const attachments = detail.attachments.map(({ r2_key: _key, ...a }) => a);
    return c.json({ ...detail, messages: detail.messages.map(publicMessage), attachments });
  });

  api.patch("/api/tickets/:ref", async (c) => {
    const b = await body<{ status: TicketStatus; priority: TicketPriority; assignee: string | null; metadata: Record<string, string>; partition: string | null }>(c);
    const p = staff(c);
    const patch: TicketPatch = {};
    if (b.metadata !== undefined) patch.metadata = metadataField(b.metadata);
    if (b.partition !== undefined) {
      // Moving a ticket between tenants (e.g. a verified email ticket to the sender's company): operators only.
      if (p.role !== "admin" || p.partition !== null) throw new HttpError(403, "only an unrestricted admin can change a ticket's partition");
      patch.partition = partitionField(b.partition) ?? null;
    }
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
          if (!agent || !agent.active || !(await canWork(r, agent, ticket.partition))) {
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
    const p = staff(c);
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
    const p = staff(c);
    const idemHeader = idempotencyKey(c);

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
    const who = principal(c);
    const msg = await withRepo(c.env, (r) => (who.kind === "requester" ? requester.messageOr404(c, r, who, c.req.param("id")) : messageOr404(c, r, c.req.param("id"))));
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
      const who = principal(c);
      await (who.kind === "requester" ? requester.messageOr404(c, r, who, a.message_id) : messageOr404(c, r, a.message_id));
      return a;
    });
    const obj = await c.env.MAIL.get(att.r2_key);
    if (!obj) throw new HttpError(404, "attachment not found");
    const name = (att.filename ?? "attachment").replace(/[\x00-\x1f\x7f"\\/]/g, "_").slice(0, 200);
    return new Response(obj.body, {
      headers: {
        "content-type": /^[\w.+-]+\/[\w.+-]+$/.test(att.mime_type) ? att.mime_type : "application/octet-stream",
        "content-length": String(obj.size),
        "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${rfc5987(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  });

  return api;
}
