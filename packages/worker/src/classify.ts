import type { HelpdeskEnv } from "./env";
import {
  type ClassificationAttempt,
  type ClassificationConfig,
  type ClassificationOutcome,
  decide,
  type InboundMessageMeta,
  isAccepted,
  prepareInput,
  snapshotConfig,
  type Ticket,
  validateResult,
} from "@rolandihms/helpdesk-core";
import { withRepo } from "@rolandihms/helpdesk-db";
import type { WorkflowStep } from "cloudflare:workers";

/**
 * Classification stage of the inbound Workflow (docs/AI-PIPELINE.md §1–3).
 * - `classify:config` snapshots the config; every later decision reads the snapshot (replay-safe).
 * - one step per classifier, cheapest first; stops at the first confident result.
 * - transient classifier errors are retried by the step; permanent ones are recorded and skipped.
 */
export async function classifyStage(
  step: WorkflowStep,
  env: HelpdeskEnv,
  config: ClassificationConfig<HelpdeskEnv>,
  ticket: Ticket,
  inboundMessageId: string,
  meta: InboundMessageMeta,
): Promise<{ outcome: ClassificationOutcome; ticket: Ticket }> {
  const snap = await step.do("classify:config", async () => snapshotConfig(config));

  const input = await step.do("classify:input", async () => {
    const text = meta.textKey ? ((await (await env.MAIL.get(meta.textKey))?.text()) ?? meta.textPreview) : meta.textPreview;
    return prepareInput({ ticketRef: ticket.ref, subject: meta.subject, text, from: meta.from.address }, snap);
  });

  const attempts: ClassificationAttempt[] = [];
  for (const name of snap.classifierNames) {
    let attempt: ClassificationAttempt;
    try {
      attempt = await step.do(
        `classify:${name}`,
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        async (): Promise<ClassificationAttempt> => {
          const classifier = config.classifiers.find((c) => c.name === name);
          if (!classifier) return { classifier: name, result: null, error: "classifier no longer configured", durationMs: 0 };
          const t0 = Date.now();
          const raw = await classifier.classify(input, { env });
          const durationMs = Date.now() - t0;
          if (!raw) return { classifier: name, result: null, durationMs };
          const { meta: m, ...rest } = raw;
          try {
            return { classifier: name, result: validateResult(rest, snap), ...(m ? { meta: m } : {}), durationMs };
          } catch (err) {
            // Invalid output is permanent for this input: record, don't retry.
            return { classifier: name, result: null, error: `invalid result: ${String(err)}`, ...(m ? { meta: m } : {}), durationMs };
          }
        },
      );
    } catch (err) {
      attempt = { classifier: name, result: null, error: err instanceof Error ? err.message : String(err), durationMs: 0 };
    }
    attempts.push(attempt);
    if (isAccepted(attempt, snap)) break;
  }

  const outcome = decide(attempts, snap);
  const updated = await step.do("classify:save", () =>
    withRepo(env, async (repo) => {
      await repo.saveClassification({ ticket, messageId: inboundMessageId, outcome });
      return (await repo.getTicket(ticket.id))!;
    }),
  );
  console.log(JSON.stringify({ msg: "ticket classified", ref: ticket.ref, category: outcome.category, confidence: outcome.confidence, acceptedBy: outcome.acceptedBy }));
  return { outcome, ticket: updated };
}
