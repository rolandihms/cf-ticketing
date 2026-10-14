// Your help desk configuration. Add plugins here: each hook runs inside the inbound Workflow,
// after the ticket is persisted and acknowledged. See docs/PLUGINS.md.
import { defineHelpdesk } from "@cf-helpdesk/core";
import { loggerPlugin } from "./src/plugins/logger";

export default defineHelpdesk<Env>({
  ackNewTickets: true,
  plugins: [loggerPlugin],
});
