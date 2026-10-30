import type { ClassificationConfig, ClassificationOutcome } from "./classification";
import type { InboundMessageMeta, Mailbox, Ticket } from "./types";

/** Subset of Workflows' WorkflowStep that plugins may use; step names are namespaced per plugin. */
export interface PluginStep {
  /** Durable, retried (default 2 retries) and memoised: side effects belong in here. */
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}

/** A link from a ticket to an object in another system (e.g. a GitHub issue). */
export interface TicketLink {
  /** e.g. "github" */
  provider: string;
  /** Unique within the provider, e.g. "owner/repo#123" */
  externalId: string;
  url: string | null;
  state: string | null;
  data?: Record<string, unknown>;
}

/** Storage operations plugins may perform on the current ticket. Call them inside `step.do`. */
export interface TicketServices {
  addEvent(type: string, data?: Record<string, unknown>): Promise<void>;
  getLink(provider: string): Promise<TicketLink | null>;
  /** Insert-if-absent per (ticket, provider); returns the stored link (existing one wins). */
  saveLink(link: TicketLink): Promise<TicketLink>;
}

/**
 * A domain event delivered to `onEvent`. Built-in types: ticket.created, message.received,
 * ticket.classified, and the agent actions in AGENT_EVENTS. Plugins add their own via `ctx.emit`
 * (e.g. github.issue.created).
 */
export interface HelpdeskEvent {
  /** Deterministic per ticket Workflow run; use it to dedupe deliveries. */
  id: string;
  type: string;
  occurredAt: number;
  /** Plugin that emitted it, or "core". */
  source: string;
  data: Record<string, unknown>;
}

export type BuiltinEvent = "ticket.created" | "message.received" | "ticket.classified";

/** Events raised by agent actions through the API; delivered to `onEvent` only. */
export const AGENT_EVENTS = ["ticket.status_changed", "ticket.priority_changed", "ticket.assigned", "ticket.replied", "ticket.note_added"] as const;
export type AgentEvent = (typeof AGENT_EVENTS)[number];

/** Context for `onEvent`. Events from agent actions have no inbound email (`message` is absent). */
export interface EventContext<Env = unknown> extends Omit<HookContext<Env>, "event" | "message"> {
  /** What triggered this delivery: a built-in inbound event, or "agent.action" for API actions. */
  event: BuiltinEvent | "agent.action";
  /** The inbound email, when the event came from one. */
  message?: InboundMessageMeta;
  helpdeskEvent: HelpdeskEvent;
}

export interface HookContext<Env = unknown> {
  event: BuiltinEvent;
  ticket: Ticket;
  mailbox: Mailbox;
  message: InboundMessageMeta;
  env: Env;
  step: PluginStep;
  services: TicketServices;
  log: (msg: string, data?: Record<string, unknown>) => void;
  /** Present when classification ran for this message (always for ticket.classified). */
  classification?: ClassificationOutcome;
  /**
   * Publish an event to every other plugin's `onEvent` (and record it on the ticket).
   * Types are `namespace.name` in lowercase, e.g. "github.issue.created".
   */
  emit(type: string, data: Record<string, unknown>): Promise<void>;
}

export interface HelpdeskPlugin<Env = unknown> {
  name: string;
  onTicketCreated?(ctx: HookContext<Env>): Promise<void>;
  onMessageReceived?(ctx: HookContext<Env>): Promise<void>;
  /** After classification is persisted; `ctx.classification` is set. Route on it (e.g. GitHub issues). */
  onTicketClassified?(ctx: HookContext<Env> & { classification: ClassificationOutcome }): Promise<void>;
  /** Every built-in, agent-action and plugin-emitted event (except the plugin's own). Good for fan-out (webhooks). */
  onEvent?(ctx: EventContext<Env>): Promise<void>;
}

export interface HelpdeskConfig<Env = unknown> {
  plugins: HelpdeskPlugin<Env>[];
  /** Acknowledge new tickets by email. Default true. */
  ackNewTickets?: boolean;
  /**
   * Treat an inbound From address as proven only when the receiving MTA reports dmarc=pass. Unproven senders
   * still open tickets, but get no ack and can't join a ticket by quoting its ref. Default true; turn it off
   * only if your MTA doesn't add Authentication-Results.
   */
  requireDmarc?: boolean;
  /** Auth-serv-ids whose Authentication-Results header is trusted. Default: Cloudflare Email Routing's ("mx.cloudflare.net"). */
  trustedAuthServIds?: string[];
  /** Classification cascade (docs/AI-PIPELINE.md). Omit to disable classification. */
  classification?: ClassificationConfig<Env>;
}

export const EVENT_TYPE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function defineHelpdesk<Env>(config: HelpdeskConfig<Env>): HelpdeskConfig<Env> {
  const names = new Set<string>();
  for (const p of config.plugins) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.name)) throw new Error(`Invalid plugin name "${p.name}"`);
    if (names.has(p.name)) throw new Error(`Duplicate plugin name "${p.name}"`);
    names.add(p.name);
  }
  return config;
}
