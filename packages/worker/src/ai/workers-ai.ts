import type { LlmChatRequest, LlmChatResponse, LlmProvider } from "@rolandihms/helpdesk-core";

export const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * LlmProvider over the Workers AI binding: no API keys, no egress, runs in your Cloudflare account
 * (preferred for raw customer text). Optionally routed through an AI Gateway for logs/caching.
 *
 * Workers AI JSON mode takes a *raw* JSON Schema (`json_schema: <schema>`), unlike OpenAI's
 * `{ name, schema }` wrapper, and only some models support it (llama-3.3-70b-fp8-fast does).
 */
export function workersAI(ai: Ai, opts: { model?: string; gatewayId?: string } = {}): LlmProvider {
  const model = opts.model || DEFAULT_WORKERS_AI_MODEL;
  return {
    id: "workers-ai",
    model,
    async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
      const inputs: Record<string, unknown> = {
        messages: req.messages,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 600,
        ...(req.schema ? { response_format: { type: "json_schema", json_schema: req.schema.schema } } : {}),
      };
      const options = opts.gatewayId ? { gateway: { id: opts.gatewayId } } : undefined;
      const out = (await (ai.run as (m: string, i: unknown, o?: unknown) => Promise<unknown>)(model, inputs, options)) as {
        response?: unknown;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const resp = out?.response;
      return {
        text: typeof resp === "string" ? resp : JSON.stringify(resp ?? ""),
        ...(resp && typeof resp === "object" ? { json: resp } : {}),
        provider: "workers-ai",
        model,
        ...(out?.usage ? { usage: { inputTokens: out.usage.prompt_tokens, outputTokens: out.usage.completion_tokens } } : {}),
        ...(ai.aiGatewayLogId ? { logId: ai.aiGatewayLogId } : {}),
      };
    },
  };
}
