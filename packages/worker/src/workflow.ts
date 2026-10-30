import {
  type ClassificationOutcome,
  type GuardResult,
  type HelpdeskEvent,
  type InboundMessageMeta,
  type Mailbox,
  normalizeMessageId,
  type Ticket,
} from "@rolandihms/helpdesk-core";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { HelpdeskEnv } from "./env";
import type { HelpdeskOptions } from "./options";
import { withRepo } from "@rolandihms/helpdesk-db";
import { newMessageId, sendViaBinding, type SendFormat } from "./email/outbound";
import { parseAndStore, type StoredRawRef } from "./email/parse";
import { ackTemplate, NOTIFY_BODY_MAX, newTicketTemplate, ticketUrl } from "./email/templates";
import { ingestInbound } from "./ingest";
import { classifyStage } from "./classify";
import { PluginRunner } from "./plugins/runner";
import { ticketServices } from "./plugins/services";

export interface InboundParams extends StoredRawRef {
  guard: GuardResult;
  /** "workflow": this Workflow sends the ack. "handled": already acked in the email handler (ACK_MODE=reply). "none": no ack. */
  ack: "workflow" | "handled" | "none";
}

export interface InboundOutput {
  ticketRef: string;
  ticketId: string;
  created: boolean;
  threadedBy: string;
  acked: boolean;
  category?: string;
}

/** The inbound Workflow body: parse → persist → ack → classify → plugins. */
export async function runInbound(config: HelpdeskOptions, env: HelpdeskEnv, event: WorkflowEvent<InboundParams>, step: WorkflowStep): Promise<InboundOutput> {
  const p = event.payload;

  const meta = await step.do("parse", () => parseAndStore(env.MAIL, p));

  const persisted = await step.do("persist", () =>
    withRepo(env, async (repo) => {
      const mailbox = await repo.getMailboxByAddress(p.mailboxAddress);
      if (!mailbox) throw new Error(`mailbox ${p.mailboxAddress} not found`);
      const r = await ingestInbound(repo, mailbox, meta, p.guard);
      return { mailbox, ticket: r.ticket, created: r.created, messageId: r.messageId, threadedBy: r.threadedBy };
    }),
  );
  const { mailbox } = persisted;
  const shouldAck = p.ack === "workflow" && persisted.created && p.guard.allowAutoReply && config.ackNewTickets !== false;
  const acked = shouldAck ? await sendAck(env, step, mailbox, persisted.ticket, meta) : false;
  // Bounces, auto-replies and list mail never notify staff.
  const automated = p.guard.reasons.some((r) => !r.startsWith("dmarc-"));
  const { ticket, classified } = await afterIngest(config, env, step, {
    mailbox, ticket: persisted.ticket, created: persisted.created, messageId: persisted.messageId, meta,
    senderVerified: p.guard.senderVerified, notify: !automated,
  });
  return { ticketRef: ticket.ref, ticketId: ticket.id, created: persisted.created, threadedBy: persisted.threadedBy, acked: acked || p.ack === "handled", ...(classified ? { category: classified.outcome.category } : {}) };
}

/** Acknowledge a new ticket by email and record it. Step names are part of the Workflow's replay contract. */
async function sendAck(env: HelpdeskEnv, step: WorkflowStep, mailbox: Mailbox, ticket: Ticket, meta: InboundMessageMeta) {
  const sent = await step.do(
    "ack:send",
    { retries: { limit: 6, delay: "1 minute", backoff: "exponential" }, timeout: "2 minutes" },
    async () => {
      const tpl = ackTemplate(mailbox, ticket, meta);
      const messageId = newMessageId(mailbox.address.split("@")[1]!);
      const res = await sendViaBinding(
        env.EMAIL,
        {
          from: { email: mailbox.address, name: mailbox.fromName ?? mailbox.name },
          to: { email: meta.from.address, name: meta.from.name },
          subject: tpl.subject,
          text: tpl.text,
          html: tpl.html,
          messageId,
          inReplyTo: meta.messageId,
          references: meta.references.slice().reverse(),
          ticketRef: ticket.ref,
          autoSubmitted: true,
        },
        (env.EMAIL_SEND_FORMAT as SendFormat) || "raw",
      );
      const providerMessageId = res.providerMessageId ? normalizeMessageId(res.providerMessageId) ?? res.providerMessageId : null;
      return { messageId, providerMessageId, subject: tpl.subject, text: tpl.text };
    },
  );
  // Separate step so a DB hiccup here never re-sends the email (step results are cached).
  await step.do("ack:record", () =>
    withRepo(env, (repo) => repo.appendMessage({
      ticket,
      reopen: false,
      actor: "system:ack",
      attachments: [],
      message: {
        direction: "outbound",
        kind: "ack",
        ingest_key: null,
        message_id_hdr: sent.messageId,
        provider_msg_id: sent.providerMessageId,
        in_reply_to: meta.messageId,
        from_addr: mailbox.address,
        to_json: JSON.stringify([meta.from.address]),
        cc_json: null,
        subject: sent.subject,
        text_preview: sent.text.slice(0, 500),
        text_r2_key: null,
        html_r2_key: null,
        raw_r2_key: null,
        auth_json: null,
        author_agent_id: null,
      },
    })),
  );
  return true;
}

/**
 * Everything after a message is stored, for mail and for portal/app messages alike: classify (new tickets,
 * and replies if enabled), notify staff about new tickets, then run the plugins.
 */
async function afterIngest(
  config: HelpdeskOptions,
  env: HelpdeskEnv,
  step: WorkflowStep,
  x: { mailbox: Mailbox; ticket: Ticket; created: boolean; messageId: string; meta: InboundMessageMeta; senderVerified: boolean; notify: boolean },
) {
  const { mailbox, meta } = x;
  let ticket = x.ticket;
  const cls = config.classification;
  const classified = cls && (x.created || cls.reclassifyOnReply) ? await classifyStage(step, env, cls, ticket, x.messageId, meta) : undefined;
  if (classified) ticket = classified.ticket;

  // `?? []`: a run that started before the upgrade has a cached mailbox without the field.
  const recipients = mailbox.notifyNewTicket ?? [];
  if (x.created && x.notify && recipients.length) {
    await notifyNewTicket(env, step, { mailbox, ticket, meta, recipients, senderVerified: x.senderVerified, ...(classified ? { classification: classified.outcome } : {}) });
  }

  const onFailure = (plugin: string, error: string) =>
    withRepo(env, (repo) => repo.addEvent(ticket.id, "plugin.failed", `plugin:${plugin}`, { error }));
  const base = { ticket, mailbox, message: meta, env: env, ...(classified ? { classification: classified.outcome } : {}) };
  const runner = new PluginRunner(config, step, (actor) => ticketServices(env, ticket.id, actor), base, onFailure, meta.ingestKey.slice(0, 12));
  await runner.dispatch(x.created ? "ticket.created" : "message.received");
  if (classified) await runner.dispatch("ticket.classified");
  return { ticket, classified };
}

/**
 * Email each recipient a copy of the new ticket, one durable step per address so a retry never re-sends to
 * the others. A failure is recorded on the ticket, never fails the Workflow: the ticket is already safe.
 */
async function notifyNewTicket(
  env: HelpdeskEnv,
  step: WorkflowStep,
  n: { mailbox: Mailbox; ticket: Ticket; meta: InboundMessageMeta; recipients: string[]; senderVerified: boolean; classification?: ClassificationOutcome },
) {
  const { mailbox, ticket, meta } = n;
  const body = await step.do("notify:body", async () => {
    const obj = meta.textKey ? await env.MAIL.get(meta.textKey) : null;
    return obj ? (await obj.text()).slice(0, NOTIFY_BODY_MAX + 1) : meta.textPreview;
  });
  const tpl = newTicketTemplate({ ...n, inbound: meta, body, ticketUrl: ticketUrl(env.TICKET_URL, ticket.ref) });
  const sent: string[] = [];
  const failed: { to: string; error: string }[] = [];
  for (const to of n.recipients) {
    try {
      await step.do(`notify:${to}`, { retries: { limit: 6, delay: "1 minute", backoff: "exponential" }, timeout: "2 minutes" }, async () => {
        await sendViaBinding(
          env.EMAIL,
          {
            from: { email: mailbox.address, name: mailbox.fromName ?? mailbox.name },
            to: { email: to, name: null },
            subject: tpl.subject,
            text: tpl.text,
            html: tpl.html,
            messageId: newMessageId(mailbox.address.split("@")[1]!),
            ticketRef: ticket.ref,
            autoSubmitted: "auto-generated",
          },
          (env.EMAIL_SEND_FORMAT as SendFormat) || "raw",
        );
        return true;
      });
      sent.push(to);
    } catch (err) {
      failed.push({ to, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await step.do("notify:record", () =>
    withRepo(env, async (repo) => {
      if (sent.length) await repo.addEvent(ticket.id, "notification.sent", "system:notify", { to: sent });
      for (const f of failed) await repo.addEvent(ticket.id, "notification.failed", "system:notify", f);
    }),
  );
}

/** Agent actions (API) whose events are delivered to plugins' onEvent, durably and with retries. */
export interface AgentEventsParams {
  kind: "agent-events";
  /** Unique per API action; part of every event id. */
  actionId: string;
  ticketId: string;
  events: Omit<HelpdeskEvent, "id">[];
}

/** A ticket or reply a requester (or staff on their behalf) posted through the API (portal/app). */
export interface PortalParams {
  kind: "portal";
  ticketId: string;
  messageId: string;
  /** The message opened the ticket. */
  created: boolean;
  /** Email the requester an acknowledgement (new tickets only). */
  ack: boolean;
}

export type HelpdeskWorkflowParams = InboundParams | AgentEventsParams | PortalParams;

export const isAgentEvents = (p: Readonly<HelpdeskWorkflowParams>): p is Readonly<AgentEventsParams> => (p as AgentEventsParams).kind === "agent-events";
export const isPortal = (p: Readonly<HelpdeskWorkflowParams>): p is Readonly<PortalParams> => (p as PortalParams).kind === "portal";

/** The portal/app counterpart of runInbound: the message is already stored, so ack → classify → notify → plugins. */
export async function runPortal(config: HelpdeskOptions, env: HelpdeskEnv, event: WorkflowEvent<PortalParams>, step: WorkflowStep) {
  const p = event.payload;
  const loaded = await step.do("load", () =>
    withRepo(env, async (repo) => {
      const ticket = await repo.getTicket(p.ticketId);
      const message = await repo.getMessage(p.messageId);
      const mailbox = ticket ? await repo.getMailbox(ticket.mailboxId) : null;
      const author = message ? await repo.getContact(message.author_contact_id ?? ticket?.requesterId ?? "") : null;
      if (!ticket || !message || !mailbox || !author) return null;
      const meta: InboundMessageMeta = {
        ingestKey: message.ingest_key ?? message.id,
        mailboxAddress: mailbox.address,
        envelopeFrom: author.email,
        from: { address: author.email, name: author.name },
        to: [mailbox.address],
        cc: [],
        subject: message.subject,
        messageId: null,
        inReplyTo: null,
        references: [],
        date: Number(message.created_at),
        rawKey: "",
        textKey: message.text_r2_key,
        htmlKey: null,
        textPreview: message.text_preview ?? "",
        attachments: [],
      };
      return { ticket, mailbox, meta };
    }),
  );
  if (!loaded) return { skipped: true };
  const { mailbox, meta } = loaded;
  const acked = p.created && p.ack && config.ackNewTickets !== false ? await sendAck(env, step, mailbox, loaded.ticket, meta) : false;
  const { ticket, classified } = await afterIngest(config, env, step, {
    mailbox, ticket: loaded.ticket, created: p.created, messageId: p.messageId, meta, senderVerified: true, notify: true,
  });
  return { ticketRef: ticket.ref, acked, ...(classified ? { category: classified.outcome.category } : {}) };
}

/** Start the Workflow for a portal/app message. A failure is logged: the message itself is stored. */
export async function queuePortal(env: HelpdeskEnv, params: Omit<PortalParams, "kind">) {
  try {
    await env.INBOUND_WORKFLOW.create({ id: `portal-${params.messageId}`, params: { kind: "portal", ...params } satisfies PortalParams });
  } catch (err) {
    console.error(JSON.stringify({ msg: "could not queue portal message", ticketId: params.ticketId, error: String(err) }));
  }
}

export async function runAgentEvents(config: HelpdeskOptions, env: HelpdeskEnv, event: WorkflowEvent<AgentEventsParams>, step: WorkflowStep) {
  const p = event.payload;
  const loaded = await step.do("load", () =>
    withRepo(env, async (repo) => {
      const ticket = await repo.getTicket(p.ticketId);
      const mailbox = ticket ? ((await repo.listMailboxes()).find((m) => m.id === ticket.mailboxId) ?? null) : null;
      return ticket && mailbox ? { ticket, mailbox } : null;
    }),
  );
  if (!loaded) return { delivered: 0 };
  const { ticket, mailbox } = loaded;
  const onFailure = (plugin: string, error: string) => withRepo(env, (repo) => repo.addEvent(ticket.id, "plugin.failed", `plugin:${plugin}`, { error }));
  const runner = new PluginRunner(config, step, (actor) => ticketServices(env, ticket.id, actor), { ticket, mailbox, env }, onFailure, p.actionId);
  await runner.deliver(p.events);
  return { delivered: p.events.length };
}

/**
 * Hand agent-action events to the Workflow (only if a plugin listens). Called after the action is
 * committed; a failure here is logged, never surfaced: the action itself succeeded and is recorded
 * in ticket_events either way.
 */
export async function queueAgentEvents(config: HelpdeskOptions, env: HelpdeskEnv, ticketId: string, events: AgentEventsParams["events"]) {
  if (!events.length || !config.plugins.some((pl) => pl.onEvent)) return;
  const actionId = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.INBOUND_WORKFLOW.create({ id: `act-${actionId}`, params: { kind: "agent-events", actionId, ticketId, events } satisfies AgentEventsParams });
  } catch (err) {
    console.error(JSON.stringify({ msg: "could not queue agent events", ticketId, types: events.map((e) => e.type), error: String(err) }));
  }
}
