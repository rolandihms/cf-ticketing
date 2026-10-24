// Your help desk configuration. See docs/PLUGINS.md and docs/AI-PIPELINE.md.
import { DEFAULT_CATEGORIES, defineHelpdesk, llmClassifier, rulesClassifier } from "@cf-helpdesk/core";
import { githubIssues, webhooks } from "@cf-helpdesk/plugins";
import { loggerPlugin, workersAI } from "@cf-helpdesk/worker";

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

  plugins: [
    loggerPlugin,

    // Optional: open a GitHub issue for code-related bug tickets. Off until GITHUB_REPO and the
    // GITHUB_TOKEN secret are set. Route per mailbox by returning a different repo from `repo`.
    githubIssues<Env>({
      repo: ({ env }) => env.GITHUB_REPO || null,
      token: (env) => env.GITHUB_TOKEN,
      // when: (c) => c.category === "bug" && c.codeRelated && c.confidence >= 0.7,   // the default
    }),

    // Optional: notify another system (signed POST) when things happen. Off until WEBHOOK_URL is set.
    webhooks<Env>({
      endpoints: [
        {
          name: "default",
          url: (env) => env.WEBHOOK_URL || undefined,
          secret: (env) => env.WEBHOOK_SECRET,
          events: ["github.issue.created", "ticket.classified"],
        },
      ],
    }),
  ],
});
