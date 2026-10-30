import { createHelpdesk } from "@rolandihms/helpdesk-worker";
import config from "../helpdesk.config";
import { withDevIdentity } from "./dev-identity";

const helpdesk = createHelpdesk(config);

export const InboundEmailWorkflow = helpdesk.InboundEmailWorkflow;

export default {
  // Static assets (the UI) are served without running the Worker; only /api/* and /health get here.
  fetch: (request, env, ctx) => helpdesk.fetch(withDevIdentity(request, env), env, ctx),
  email: helpdesk.email,
} satisfies ExportedHandler<Env>;
