import type { ClassificationConfig, ClassificationOutcome } from "./classification";
import type { InboundMessageMeta, Mailbox, Ticket } from "./types";

/** Subset of Workflows' WorkflowStep that plugins may use; step names are namespaced per plugin. */
export interface PluginStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}

export interface HookContext<Env = unknown> {
  event: "ticket.created" | "message.received" | "ticket.classified";
  ticket: Ticket;
  mailbox: Mailbox;
  message: InboundMessageMeta;
  env: Env;
  step: PluginStep;
  log: (msg: string, data?: Record<string, unknown>) => void;
  /** Present when classification ran for this message (always for ticket.classified). */
  classification?: ClassificationOutcome;
}

export interface HelpdeskPlugin<Env = unknown> {
  name: string;
  onTicketCreated?(ctx: HookContext<Env>): Promise<void>;
  onMessageReceived?(ctx: HookContext<Env>): Promise<void>;
  /** After classification is persisted; `ctx.classification` is set. Route on it (e.g. GitHub issues). */
  onTicketClassified?(ctx: HookContext<Env> & { classification: ClassificationOutcome }): Promise<void>;
}

export interface HelpdeskConfig<Env = unknown> {
  plugins: HelpdeskPlugin<Env>[];
  /** Acknowledge new tickets by email. Default true. */
  ackNewTickets?: boolean;
  /** Classification cascade (docs/AI-PIPELINE.md). Omit to disable classification. */
  classification?: ClassificationConfig<Env>;
}

export function defineHelpdesk<Env>(config: HelpdeskConfig<Env>): HelpdeskConfig<Env> {
  const names = new Set<string>();
  for (const p of config.plugins) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.name)) throw new Error(`Invalid plugin name "${p.name}"`);
    if (names.has(p.name)) throw new Error(`Duplicate plugin name "${p.name}"`);
    names.add(p.name);
  }
  return config;
}
