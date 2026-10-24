import {
  type BuiltinEvent,
  EVENT_TYPE_RE,
  type HelpdeskConfig,
  type HelpdeskEvent,
  type HelpdeskPlugin,
  type HookContext,
  type PluginStep,
  type TicketServices,
} from "@cf-helpdesk/core";
import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

type Base<Env> = Omit<HookContext<Env>, "event" | "step" | "log" | "emit" | "services">;

/** Safety valve against plugins emitting events in a loop. */
const MAX_EVENTS_PER_RUN = 50;

/**
 * Runs plugin hooks inside the inbound Workflow and delivers events between plugins.
 *
 * - Each hook gets a namespaced step wrapper: step names are Workflow cache keys, so they are
 *   prefixed `plugin:<name>:<event>:` (or `plugin:<name>:on:<seq>:` for onEvent) to avoid collisions.
 * - A failing plugin is recorded on the ticket and skipped; it never fails the ticket's Workflow.
 * - `ctx.emit()` queues an event; queued events are delivered to every *other* plugin's `onEvent`.
 *   Event ids/sequence numbers are deterministic, so replays deliver the same ids (consumers dedupe).
 * - Changing the plugin list affects in-flight instances (new plugins run, removed ones are skipped).
 */
export class PluginRunner<Env> {
  private seq = 0;
  private readonly queue: HelpdeskEvent[] = [];

  constructor(
    private readonly config: HelpdeskConfig<Env>,
    private readonly step: WorkflowStep,
    private readonly servicesFor: (actor: string) => TicketServices,
    private readonly base: Base<Env>,
    private readonly onFailure: (plugin: string, error: string) => Promise<void>,
  ) {}

  /** Run the named hook for a built-in event, then deliver it (and anything emitted) via onEvent. */
  async dispatch(event: BuiltinEvent) {
    // Queue the built-in event first so subscribers see it before anything the hooks emit.
    this.queue.push(this.builtinEvent(event));
    for (const plugin of this.config.plugins) {
      const hook = (
        event === "ticket.created" ? plugin.onTicketCreated : event === "message.received" ? plugin.onMessageReceived : plugin.onTicketClassified
      ) as ((ctx: HookContext<Env>) => Promise<void>) | undefined;
      if (hook) await this.run(plugin, event, `plugin:${plugin.name}:${event}:`, (ctx) => hook.call(plugin, ctx));
    }
    await this.drain(event);
  }

  private builtinEvent(type: BuiltinEvent): HelpdeskEvent {
    const { ticket, classification } = this.base;
    const data: Record<string, unknown> = { ticketId: ticket.id, ticketRef: ticket.ref, status: ticket.status, priority: ticket.priority };
    if (type === "ticket.classified" && classification) {
      Object.assign(data, {
        category: classification.category,
        confidence: classification.confidence,
        codeRelated: classification.codeRelated,
        acceptedBy: classification.acceptedBy,
      });
    }
    // Built-ins are already recorded in ticket_events by the repo; occurredAt comes from persisted state.
    return { id: this.nextId(type), type, occurredAt: ticket.updatedAt, source: "core", data };
  }

  private nextId(type: string) {
    // ingestKey is unique per Workflow run (one inbound email), seq is deterministic within it.
    return `${this.base.ticket.ref}:${this.base.message.ingestKey.slice(0, 12)}:${++this.seq}:${type}`;
  }

  private async drain(event: BuiltinEvent) {
    let delivered = 0;
    while (this.queue.length) {
      const ev = this.queue.shift()!;
      if (++delivered > MAX_EVENTS_PER_RUN) {
        console.warn(JSON.stringify({ msg: "event limit reached; dropping", type: ev.type, ticket: this.base.ticket.ref }));
        continue;
      }
      for (const plugin of this.config.plugins) {
        if (!plugin.onEvent || plugin.name === ev.source) continue;
        const seq = ev.id.split(":")[2];
        await this.run(plugin, event, `plugin:${plugin.name}:on:${seq}:`, (ctx) => plugin.onEvent!.call(plugin, { ...ctx, helpdeskEvent: ev }));
      }
    }
  }

  private async run(plugin: HelpdeskPlugin<Env>, event: BuiltinEvent, prefix: string, invoke: (ctx: HookContext<Env>) => Promise<void>) {
    const step = this.step;
    const services = this.servicesFor(`plugin:${plugin.name}`);
    // Errors carrying an HTTP `status` of 4xx (except 408/429) won't succeed on retry: fail fast.
    const guarded = <T>(fn: () => Promise<T>) => async () => {
      try {
        return await fn();
      } catch (err) {
        const status = (err as { status?: unknown })?.status;
        if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          throw new NonRetryableError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    };
    const pluginStep: PluginStep = {
      do: <T>(name: string, fn: () => Promise<T>) =>
        step.do(prefix + name, { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } }, guarded(fn) as () => Promise<never>) as Promise<T>,
      sleep: (name, duration) => step.sleep(prefix + name, duration as never),
    };
    const log = (msg: string, data?: Record<string, unknown>) =>
      console.log(JSON.stringify({ plugin: plugin.name, event, ticket: this.base.ticket.ref, msg, ...data }));
    const emit = async (type: string, data: Record<string, unknown>) => {
      if (!EVENT_TYPE_RE.test(type) || type.length > 64) throw new Error(`Invalid event type "${type}" (use namespace.name, max 64 chars)`);
      const id = this.nextId(type);
      const seq = id.split(":")[2];
      const occurredAt = await step.do(`${prefix}emit:${seq}:${type}`, async () => {
        await services.addEvent(type, { ...data, eventId: id });
        return Date.now();
      });
      this.queue.push({ id, type, occurredAt, source: plugin.name, data });
    };
    try {
      await invoke({ ...this.base, event, step: pluginStep, log, emit, services });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do(`${prefix}failed`, async () => {
        await this.onFailure(plugin.name, message);
      });
    }
  }
}
