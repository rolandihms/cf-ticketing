// @rolandihms/helpdesk-worker: the help desk as a library. Your Worker's entry point is three lines:
//
//   const helpdesk = createHelpdesk(config);
//   export const InboundEmailWorkflow = helpdesk.InboundEmailWorkflow;
//   export default { fetch: helpdesk.fetch, email: helpdesk.email };
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createApi } from "./api";
import type { HelpdeskEnv } from "./env";
import { handleEmail } from "./handler";
import type { HelpdeskOptions } from "./options";
import { type HelpdeskWorkflowParams, isAgentEvents, isPortal, runAgentEvents, runInbound, runPortal } from "./workflow";

export type { HelpdeskEnv } from "./env";
export type { HelpdeskOptions } from "./options";
export type { AgentEventsParams, HelpdeskWorkflowParams, InboundOutput, InboundParams, PortalParams } from "./workflow";
export { _clearAccessCertCache, parseTrustedIdentity, type Principal, type RequesterPrincipal, type RequesterVisibility, type StaffPrincipal, type TrustedIdentity } from "./auth";
export { workersAI, DEFAULT_WORKERS_AI_MODEL } from "./ai/workers-ai";
export { loggerPlugin } from "./plugins/logger";

/** What createHelpdesk returns: your Worker's handlers and its Workflow class. */
export interface Helpdesk<E extends HelpdeskEnv> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
  email(message: ForwardableEmailMessage, env: E, ctx?: ExecutionContext): Promise<void>;
  /** Export it from your entry point under the Workflow's class_name in wrangler.jsonc. */
  InboundEmailWorkflow: new (ctx: ExecutionContext, env: E) => WorkflowEntrypoint<E, HelpdeskWorkflowParams>;
}

export function createHelpdesk<E extends HelpdeskEnv>(options: HelpdeskOptions<E>): Helpdesk<E> {
  // Plugins and classifiers are typed for the host's Env; internally we only use the HelpdeskEnv part.
  const config = options as unknown as HelpdeskOptions;
  const resolve = <T extends HelpdeskEnv>(env: T): T => (config.tablePrefix === undefined ? env : { ...env, TABLE_PREFIX: config.tablePrefix });

  // One Workflow for inbound mail and for agent-action events (no extra binding to configure).
  class InboundEmailWorkflow extends WorkflowEntrypoint<E, HelpdeskWorkflowParams> {
    run(event: WorkflowEvent<HelpdeskWorkflowParams>, step: WorkflowStep) {
      const env = resolve(this.env as HelpdeskEnv);
      const p = event.payload;
      if (isAgentEvents(p)) return runAgentEvents(config, env, { ...event, payload: p }, step);
      if (isPortal(p)) return runPortal(config, env, { ...event, payload: p }, step);
      return runInbound(config, env, { ...event, payload: p }, step);
    }
  }

  const api = createApi(config);

  return {
    fetch: (request: Request, env: E, ctx: ExecutionContext) => api.fetch(request, resolve(env), ctx),
    email: (message: ForwardableEmailMessage, env: E, _ctx?: ExecutionContext) => handleEmail(message, resolve(env), config),
    InboundEmailWorkflow,
  };
}
