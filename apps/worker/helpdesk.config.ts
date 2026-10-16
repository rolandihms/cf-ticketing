// Your help desk configuration. See docs/PLUGINS.md and docs/AI-PIPELINE.md.
import { DEFAULT_CATEGORIES, defineHelpdesk, llmClassifier, rulesClassifier } from "@cf-helpdesk/core";
import { workersAI } from "./src/ai/workers-ai";
import { loggerPlugin } from "./src/plugins/logger";

export default defineHelpdesk<Env>({
  ackNewTickets: true,

  classification: {
    // Edit freely: ids are stored on tickets; descriptions are shown to the LLM.
    categories: DEFAULT_CATEGORIES,
    fallback: "other",
    acceptAt: 0.75,
    // Cheapest first. Add your own: any object implementing `Classifier` (see packages/core).
    classifiers: [
      rulesClassifier(),
      llmClassifier<Env>({
        provider: (env) => (env.AI ? workersAI(env.AI, { model: env.AI_MODEL, gatewayId: env.AI_GATEWAY_ID || undefined }) : null),
      }),
    ],
  },

  plugins: [loggerPlugin],
});
