import { api } from "./api";
import { handleEmail } from "./handler";

export { InboundEmailWorkflow } from "./workflow";

export default {
  fetch: api.fetch,
  email: (message, env) => handleEmail(message, env),
} satisfies ExportedHandler<Env>;
