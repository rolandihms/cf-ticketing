import { createHelpdesk } from "@cf-helpdesk/worker";
import config from "../helpdesk.config";

const helpdesk = createHelpdesk(config);

export const InboundEmailWorkflow = helpdesk.InboundEmailWorkflow;

export default {
  fetch: helpdesk.fetch,
  email: helpdesk.email,
} satisfies ExportedHandler<Env>;
