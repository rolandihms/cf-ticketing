import { type GuardResult, type HelpdeskEvent, normalizeMessageId } from "@cf-helpdesk/core";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { HelpdeskEnv } from "./env";
import type { HelpdeskOptions } from "./options";
import { withRepo } from "@cf-helpdesk/db";
import { newMessageId, sendViaBinding, type SendFormat } from "./email/outbound";
import { parseAndStore, type StoredRawRef } from "./email/parse";
import { ackTemplate } from "./email/templates";
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
  let ticket = persisted.ticket;

  let acked = false;
  const shouldAck = p.ack === "workflow" && persisted.created && p.guard.allowAutoReply && config.ackNewTickets !== false;
  if (shouldAck) {
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
    acked = true;
  }

  // Classify new tickets (and replies, if enabled) before plugins run, so hooks see the result.
  const cls = config.classification;
  const classified =
    cls && (persisted.created || cls.reclassifyOnReply)
      ? await classifyStage(step, env, cls, ticket, persisted.messageId, meta)
      : undefined;
  if (classified) ticket = classified.ticket;

  const onFailure = (plugin: string, error: string) =>
    withRepo(env, (repo) => repo.addEvent(ticket.id, "plugin.failed", `plugin:${plugin}`, { error }));
  const base = { ticket, mailbox, message: meta, env: env, ...(classified ? { classification: classified.outcome } : {}) };
  const runner = new PluginRunner(config, step, (actor) => ticketServices(env, ticket.id, actor), base, onFailure, meta.ingestKey.slice(0, 12));
  await runner.dispatch(persisted.created ? "ticket.created" : "message.received");
  if (classified) await runner.dispatch("ticket.classified");

  return { ticketRef: ticket.ref, ticketId: ticket.id, created: persisted.created, threadedBy: persisted.threadedBy, acked: acked || p.ack === "handled", ...(classified ? { category: classified.outcome.category } : {}) };
}

/** Agent actions (API) whose events are delivered to plugins' onEvent, durably and with retries. */
export interface AgentEventsParams {
  kind: "agent-events";
  /** Unique per API action; part of every event id. */
  actionId: string;
  ticketId: string;
  events: Omit<HelpdeskEvent, "id">[];
}

export type HelpdeskWorkflowParams = InboundParams | AgentEventsParams;

export const isAgentEvents = (p: Readonly<HelpdeskWorkflowParams>): p is Readonly<AgentEventsParams> => (p as AgentEventsParams).kind === "agent-events";

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
