# Classification, LLMs and GitHub issues: design (v2, revised after Fable review)

Goal: after a ticket is persisted, the pipeline does three things.
1. It **classifies** the ticket into configurable categories.
2. Optionally, it runs the content through **any LLM** via a gateway: Cloudflare AI Gateway, Vercel AI Gateway, OpenRouter or Workers AI.
3. If the ticket is **a code bug or code-related**, it opens a GitHub issue.

Every piece must be replaceable by custom code.

Research basis (October 2026): see [§9 Sources](#9-sources). Items marked **[verify]** still need a live test.

---

## 1. Where it runs

Everything runs inside the existing `InboundEmailWorkflow`, after `persist` and `ack`. Each external call is its own `step.do`, so it gets durability, retries and replay safety for free.

```
parse → persist → ack → classify:rules → classify:<model> … → classify:save
                                   → plugins.onTicketCreated / onMessageReceived
                                   → plugins.onTicketClassified(ctx.classification)   ← NEW hook
                                        └─ github-issues plugin: route → (approval?) → create issue → link
```

- Classification is a **built-in stage**, not a plugin. Downstream plugins need its result, so it gets a first-class `ctx.classification`.
- Classification runs for `ticket.created` by default. Running it for `message.received` is opt-in, so long threads don't re-classify on every reply.
- **Replay determinism rule.** A Workflow can replay days later, for example after a 7-day approval wait, and the config may have changed by then. So the first step, `classify:config`, **snapshots** the effective config: categories, `acceptAt`, `fallback`, classifier names, and the mailbox overrides from `settings_json`. Every later decision reads that snapshot. That includes picking the winner, applying the fallback, and the GitHub `when` predicate, which runs inside `step.do("github:route")`. Nothing that decides control flow reads live config outside a step.

## 2. Taxonomy (configurable categories)

Categories are defined in `helpdesk.config.ts`. They can be overridden per mailbox later, via `mailboxes.settings_json`.

```ts
classification: {
  categories: [
    { id: "bug",      description: "Software defect: something worked before or should work but errors/crashes/behaves wrongly", codeRelated: true },
    { id: "question", description: "How-to or usage question" },
    { id: "billing",  description: "Invoices, payments, refunds, plans" },
    { id: "feature",  description: "Request for new functionality", codeRelated: true },
    { id: "account",  description: "Login, access, password, account changes" },
    { id: "spam",     description: "Unsolicited or irrelevant" },
  ],
  fallback: "other",          // used when nothing is confident → routed to humans
  classifiers: [rules(...), llm({ provider: "default" })],   // cascade, cheapest first
  acceptAt: 0.75,             // first result with confidence ≥ this wins
}
```

## 3. Classifier interface (the extension point for custom code)

```ts
export interface ClassificationInput {
  ticket: Ticket; mailbox: Mailbox;
  subject: string; text: string;                 // text is redacted + truncated (§7)
  from: string; headers: Record<string, string>;
  categories: CategoryDef[];
}
export interface ClassificationResult {
  category: string;                // must be one of categories[].id or fallback
  confidence: number;              // 0..1
  codeRelated: boolean;
  priority?: "low" | "normal" | "high" | "urgent";
  summary?: string;                // short, redacted, safe to show externally
  tags?: string[];
  details?: Record<string, unknown>;  // e.g. { component, stepsToReproduce, expected, actual }
}
export interface Classifier<Env = unknown> {
  name: string;                                  // also the step name: classify:<name>
  classify(input: ClassificationInput, ctx: { env: Env; llm: LlmRegistry }): Promise<ClassificationResult | null>; // null = abstain
}
```

The cascade runner:
- tries classifiers in order, each in `step.do("classify:<name>")`;
- validates every result against the category enum;
- stops at the first result with `confidence ≥ acceptAt`;
- otherwise keeps the best result, or the `fallback` category;
- persists **all** attempts, for auditing and for tuning thresholds later.

Built-in classifiers:

| Classifier | Cost | What it does |
|---|---|---|
| `rules({ patterns })` | free | Regex/keyword rules on subject, body, sender domain and headers. Example: stack traces, `TypeError`, `500 Internal Server Error` and `HTTP 5xx` give `bug` with 0.9 confidence; invoice words give `billing`. Rules can also short-circuit spam and auto-replies. |
| `embeddings({ model: "@cf/baai/bge-m3", examples })` | ~free (Workers AI) | Nearest-centroid over labelled examples. Accepted when similarity and the margin over the runner-up both pass thresholds. **Phase B**, because it needs example data to tune. |
| `llm({ provider, model })` | per-token | Structured output with a JSON schema built from the category enum. Also returns `summary`, `priority`, `codeRelated` and bug `details`. |

Custom code can implement `Classifier` (a domain model, a call to an internal service, etc.) and drop it anywhere in the cascade.

## 4. LLM providers: one interface, several gateways

```ts
export interface LlmProvider {
  id: string;
  chat(req: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    schema?: { name: string; schema: JSONSchema };   // structured output
    temperature?: number; maxTokens?: number;
  }): Promise<{ text: string; json?: unknown; model: string; usage?: { in: number; out: number }; logId?: string }>;
}
```

Two implementations cover every target.

**`openAICompatible({ baseURL, apiKey, model, headers?, extraBody? })`** is a plain-`fetch` client (no SDK) that posts to `${baseURL}/chat/completions`.

| Gateway | `baseURL` | Auth / extra |
|---|---|---|
| Cloudflare AI Gateway (REST, recommended) | `https://api.cloudflare.com/client/v4/accounts/{acct}/ai/v1` | `Authorization: Bearer <CF token, AI Gateway Run>`, `cf-aig-gateway-id: <gw>` |
| Cloudflare AI Gateway (compat, deprecated but working) | `https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat` | `cf-aig-authorization` for authenticated gateways |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `Authorization: Bearer <AI_GATEWAY_API_KEY>` |
| OpenRouter | `https://openrouter.ai/api/v1` | `Authorization`, optional `HTTP-Referer` / `X-OpenRouter-Title`; `extraBody: { provider: { require_parameters: true } }` |
| OpenAI / any compatible | provider URL | provider key |

**`workersAI({ binding: env.AI, model, gatewayId? })`** wraps `env.AI.run(model, { messages, response_format }, { gateway: { id } })`. It needs no secrets or egress and is in-account, which makes it the preferred choice for raw customer text. Workers AI JSON mode takes a **raw** JSON Schema (`json_schema: <schema>`, without OpenAI's `{ name, schema }` wrapper), so the adapter translates it.

Model ids follow each gateway's `provider/model` naming. Watch the spelling differences: OpenRouter uses dots in versions, Cloudflare uses dashes. Providers are named in config (`llm.providers.default`, `llm.providers.cheap`, …) and secrets come from Worker secrets (`AI_API_KEY`, `CF_AIG_TOKEN`). Custom providers implement `LlmProvider`.

**Structured-output fallback ladder.** Each rung is a separate `step.do`, so a retry never repeats a successful call.
1. Request `response_format: json_schema` (strict where supported).
2. On a 400 or "unsupported" error, retry with `json_object` and the schema embedded in the system prompt.
3. Always strip code fences, `JSON.parse` the output and validate it (category enum, types). We use a small hand-written validator to keep the bundle small; Zod is optional.
4. If validation fails, retry once with the validation errors fed back to the model.
5. If that fails, move to the next provider in `fallbackProviders`.
6. Finally, return `null`; the cascade then uses `fallback`, and a human triages.

We will not use the Vercel `ai` SDK for now. One classification call doesn't justify its bundle size and its frequent major-version changes. Plain fetch is deterministic inside Workflow steps. We can revisit this if we add tool-calling or streaming agent replies.

## 5. Persistence (migration 0003, portable)

- `tickets` gains three columns: `category varchar(64)`, `category_confidence` (stored ×1000 as integer to avoid float differences), and `summary text`.
- `ticket_classifications` holds one row per classifier attempt: `id, ticket_id, message_id, classifier, provider, model, category, confidence_milli, code_related, accepted, result_json, error, created_at`.
- `ticket_links` records external objects: `id, ticket_id, provider ('github'), external_id varchar(255) ('owner/repo#123'), url, state, data_json, created_at, updated_at`. It has `UNIQUE(ticket_id, provider)` and `UNIQUE(provider, external_id)`. Writes use the existing `insertIgnore` pattern, so this table doubles as the idempotency record for issue creation.
- `ticket_classifications` names its error column `error_text`, and records `model`, `provider` and the gateway `log_id`. LLM calls use `temperature: 0`.
- On PlanetScale, migration 0003 goes through a deploy request (see DATABASE.md).
- Event `ticket.classified` in `ticket_events`.

## 6. GitHub issues plugin

`githubIssues({ repo, when, auth, labels, mode })` runs on the `onTicketClassified` hook.

**Routing.**
- The default `when` is: `codeRelated && category in ["bug"] && confidence ≥ 0.7`.
- `when` can be any function, so custom routing rules are just code.
- A per-mailbox repo can be set (e.g. `support@app-a.com` → `org/app-a`). This is how you plug it into your other projects.

**Mode.**
- `auto` creates the issue immediately. It is allowed only for **private** repos.
- `approval` is the default, and is forced for public repos. Public status comes from a **runtime check**, `GET /repos/{owner}/{repo}` in a `step.do`; the config is not trusted for this.
  - The workflow waits with `step.waitForEvent("github-approval", { timeout: "7 days" })`. `PluginStep` gains `waitForEvent`, namespaced like the others.
  - An agent approves via `POST /api/tickets/:ref/github/approve`, optionally editing the title and body first. The endpoint finds the Workflow instance through `tickets.source_ingest_key`, which is the instance id, and calls `instance.sendEvent({ type: "github-approval", payload })`.
  - `waitForEvent` **throws on timeout**, so the plugin catches it and records `github.approval_expired`.

**Content.**
- The issue never contains the raw email.
- The body is built from the LLM's redacted `summary` and `details` (steps to reproduce, expected and actual behaviour, component).
- It also includes the ticket ref, a hidden marker `<!-- cf-helpdesk:ticket:<id> -->` and labels (`from-helpdesk`, category).
- `@` mentions and `#` references are escaped and links are stripped.

**Idempotency.**
1. Check `ticket_links` first.
2. On an unknown outcome (a timeout after POST), list open issues with the `from-helpdesk` label and match the marker before retrying.
3. Store the link in a separate `step.do` once creation succeeds.

**Auth.**
- **Phase A:** a fine-grained PAT, limited to one repo with Issues read/write, stored as the `GITHUB_TOKEN` secret.
- **Phase B:** a GitHub App. The installation token is minted with an RS256 JWT through WebCrypto, which needs the key converted to PKCS#8 once with `openssl pkcs8 -topk8 -nocrypt`. Tokens are cached for about 50 minutes.
- Required headers: `User-Agent`, `Accept: application/vnd.github+json` and `X-GitHub-Api-Version`.
- Honour `retry-after`. GitHub's secondary limit is 80 content-creating requests per minute.

**Closing the loop (Phase C).**
- `POST /webhooks/github` verifies `X-Hub-Signature-256` with HMAC-SHA256, compared in constant time, and dedupes on `X-GitHub-Delivery`.
- On `issues.closed` it updates `ticket_links.state`, adds an event and, if configured, notifies the customer via Email Sending, with agent review first.

## 7. Safety

- **Untrusted input.**
  - Email text is data, not instructions. It only ever appears inside a delimited user message, and system prompts never interpolate it.
  - The LLM has **no tools and no side effects**. Its output is validated against enums, and code decides every action.
  - Model output never chooses a repo, a recipient or a URL.
- **Redaction before any external call.** A regex pass removes emails, phone numbers, card/IBAN-like numbers, API keys and tokens (`sk-…`, `ghp_…`, JWTs) and long hex/base64 blobs, and trims signatures and quoted history.
- **Size limits.** Input is capped at about 8k characters (subject plus the first part of the body); HTML is stripped.
- **Data residency.** Workers AI is preferred for raw text. For external providers, document the data-retention settings (OpenRouter and Vercel have zero-retention options) and gateway logging, which can be turned off.
- **GitHub.** Private repos by default, approval mode for public repos, redacted summaries only.

## 8. Phasing

| Phase | Scope |
|---|---|
| **A1** (done, PR #5) | Migration 0003; `Classifier`/`LlmProvider` interfaces in core; the `rules` classifier, plus an `llm` classifier on the `workersAI` provider (no secrets needed); the cascade runner with the config snapshot; the `onTicketClassified` hook; the `ticket.classified` event; the classification shown in the API. |
| **A2** | The `openAICompatible` provider (Cloudflare AI Gateway REST, Vercel AI Gateway, OpenRouter) with the structured-output fallback ladder and redaction; mocked-fetch tests plus one live call per gateway. |
| **A3** | The GitHub plugin in `auto` mode for **private repos only**, with PAT auth, `ticket_links` idempotency and a live test against a private repo. |
| **B** | Approval mode (`waitForEvent` plus the approve API and the public-repo visibility check); the embeddings classifier; per-mailbox taxonomy and repos; GitHub App auth; the feedback loop (agent re-categorises, stored as a labelled example, plus AI Gateway `patchLog`). |
| **C** | GitHub webhook (issue closed → ticket update / customer notification); AI-suggested replies for agents. |

## 9. Classifier options research (2026-10-15)

The question was: should classification use a dedicated tool (Jev, Snap, SubQ, something from Cloudflare) or simply an LLM? Findings:

| Option | What it is | Fit |
|---|---|---|
| **Jev** (TypeSafe AI) | A non-generative "decision model". You send text plus typed questions (Choice, Score, yes/no) and get back calibrated probabilities; it cannot return invalid JSON. Early access since Sept 2026, at about $0.04 per 1k emails. Available via the TypeSafe API and **Vercel AI Gateway**. | **Strong candidate for later.** Calibrated confidence suits "act above a threshold, escalate below it". Add it as one more `Classifier` once we have a labelled set to compare against. |
| **Snap 3B** (`bm-natwest/snap-3b`) | An open, Jev-compatible model (Ministral-3B plus LoRA). Gated on Hugging Face, no license yet, trained mostly on banking data. | Not now. It needs GPU hosting outside Cloudflare. |
| **SubQ** (Subquadratic) | A long-context LLM (12M tokens). | Not a classification tool; not relevant. |
| **Workers AI classification models** | Only sentiment (`distilbert-sst-2-int8`) and a reranker. | Can't do custom categories. |
| **Workers AI LoRA** | Generative base models only (gemma, llama-2, mistral). | Encoder classifiers such as SetFit or ModernBERT can't be hosted on Workers AI. |
| **Embeddings (`@cf/baai/bge-m3`) + Vectorize** | kNN or centroid over labelled examples, with one namespace per tenant. | **Phase B.** Cheapest and fast once agents have corrected 10–30 examples per category. |
| **LLM + JSON schema** (Workers AI llama-3.3-70b-fp8-fast) | Zero-shot, with categories given in the prompt. | **Phase A1 (shipped).** No labels needed, and per-tenant categories are trivial. |

**Decision:** rules → Workers AI LLM now. Next, agent corrections become labelled examples for an embeddings/Vectorize kNN classifier placed in front of the LLM, with neighbours used as few-shot examples. Jev, Claude Haiku via a gateway, and GEPA prompt optimisation will be evaluated against that labelled set. Cost is not the deciding factor: every option is under $2 per month at our volumes.

**First live results** (ihms.dev, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`):
- A bug report without a stack trace was classified `bug` (0.9, codeRelated) in 2.6 s. It extracted component, steps to reproduce, expected and actual behaviour.
- A plan-change email was classified `billing` (0.9).

## 10. Sources

- Cloudflare AI Gateway: REST API ([changelog 2026-05-21](https://developers.cloudflare.com/changelog/post/2026-05-21-rest-api/)), [compat endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/), [authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/), [Worker binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
- Workers AI: [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- Vercel AI Gateway: [OpenAI-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions)
- OpenRouter: [structured outputs](https://openrouter.ai/docs/features/structured-outputs)
- GitHub: REST issues API, GitHub App JWT auth, webhook signature verification (docs.github.com)
