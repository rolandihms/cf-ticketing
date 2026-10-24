// @cf-helpdesk/worker: the help desk as a library. Your Worker's entry point is three lines:
//
//   const helpdesk = createHelpdesk(config);
//   export const InboundEmailWorkflow = helpdesk.InboundEmailWorkflow;
//   export default { fetch: helpdesk.fetch, email: helpdesk.email };
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { api } from "./api";
import type { HelpdeskEnv } from "./env";
import { handleEmail } from "./handler";
import type { HelpdeskOptions } from "./options";
import { type InboundOutput, type InboundParams, runInbound } from "./workflow";

export type { HelpdeskEnv } from "./env";
export type { HelpdeskOptions } from "./options";
export type { InboundOutput, InboundParams } from "./workflow";
export { _clearAccessCertCache, type Principal } from "./auth";
export { workersAI, DEFAULT_WORKERS_AI_MODEL } from "./ai/workers-ai";
export { loggerPlugin } from "./plugins/logger";

export function createHelpdesk<E extends HelpdeskEnv>(options: HelpdeskOptions<E>) {
  // Plugins and classifiers are typed for the host's Env; internally we only use the HelpdeskEnv part.
  const config = options as unknown as HelpdeskOptions;
  const resolve = <T extends HelpdeskEnv>(env: T): T => (config.tablePrefix === undefined ? env : { ...env, TABLE_PREFIX: config.tablePrefix });

  class InboundEmailWorkflow extends WorkflowEntrypoint<E, InboundParams> {
    run(event: WorkflowEvent<InboundParams>, step: WorkflowStep): Promise<InboundOutput> {
      return runInbound(config, resolve(this.env as HelpdeskEnv), event, step);
    }
  }

  return {
    fetch: (request: Request, env: E, ctx: ExecutionContext) => api.fetch(request, resolve(env), ctx),
    email: (message: ForwardableEmailMessage, env: E, _ctx?: ExecutionContext) => handleEmail(message, resolve(env)),
    InboundEmailWorkflow,
  };
}
