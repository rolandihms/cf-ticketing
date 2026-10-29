// The help desk's configuration. See docs/PLUGINS.md and docs/AI-PIPELINE.md.
import { DEFAULT_CATEGORIES, defineHelpdesk, llmClassifier, rulesClassifier } from "@rolandihms/helpdesk-core";
import { loggerPlugin, workersAI } from "@rolandihms/helpdesk-worker";

export default defineHelpdesk<Env>({
  ackNewTickets: true,
  classification: {
    categories: DEFAULT_CATEGORIES,
    fallback: "other",
    acceptAt: 0.75,
    classifiers: [
      rulesClassifier(),
      llmClassifier<Env>({
        provider: (env) => (env.AI ? workersAI(env.AI, { model: env.AI_MODEL, gatewayId: env.AI_GATEWAY_ID || undefined }) : null),
      }),
    ],
  },
  plugins: [loggerPlugin],
});
