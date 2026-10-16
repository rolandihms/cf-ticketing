import type { HelpdeskConfig, HookContext, PluginStep } from "@cf-helpdesk/core";
import type { WorkflowStep } from "cloudflare:workers";

type Event = HookContext["event"];

/**
 * Runs each plugin hook with a namespaced step wrapper. Step names act as Workflow cache keys,
 * so they are prefixed `plugin:<name>:<event>:` to avoid collisions between plugins.
 * A failing plugin is recorded and skipped; it never fails the ticket's Workflow.
 * Note: changing the plugin list affects in-flight instances (new plugins run, removed ones are skipped).
 */
export async function runPlugins<Env>(
  config: HelpdeskConfig<Env>,
  step: WorkflowStep,
  base: Omit<HookContext<Env>, "step" | "log">,
  onFailure: (plugin: string, error: string) => Promise<void>,
) {
  const event: Event = base.event;
  for (const plugin of config.plugins) {
    const hook = (
      event === "ticket.created" ? plugin.onTicketCreated : event === "message.received" ? plugin.onMessageReceived : plugin.onTicketClassified
    ) as ((ctx: HookContext<Env>) => Promise<void>) | undefined;
    if (!hook) continue;
    const prefix = `plugin:${plugin.name}:${event}:`;
    const pluginStep: PluginStep = {
      do: <T>(name: string, fn: () => Promise<T>) =>
        step.do(prefix + name, { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } }, fn as () => Promise<never>) as Promise<T>,
      sleep: (name, duration) => step.sleep(prefix + name, duration as never),
    };
    const log = (msg: string, data?: Record<string, unknown>) =>
      console.log(JSON.stringify({ plugin: plugin.name, event, ticket: base.ticket.ref, msg, ...data }));
    try {
      await hook.call(plugin, { ...base, step: pluginStep, log });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do(`${prefix}failed`, async () => {
        await onFailure(plugin.name, message);
      });
    }
  }
}
