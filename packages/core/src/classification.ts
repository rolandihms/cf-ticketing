import type { TicketPriority } from "./types";

// ---------------------------------------------------------------------------------------------
// Types (docs/AI-PIPELINE.md §2–3)
// ---------------------------------------------------------------------------------------------

export interface CategoryDef {
  /** Stable id stored on tickets, e.g. "bug". Lowercase letters, digits, dashes. */
  id: string;
  /** Plain-language description; shown to LLM classifiers. */
  description: string;
  /** Tickets in this category concern code (used by the GitHub plugin's default routing). */
  codeRelated?: boolean;
}

/** Input handed to every classifier. `text` is already redacted and truncated. */
export interface ClassificationInput {
  ticketRef: string;
  subject: string;
  text: string;
  from: string;
  categories: CategoryDef[];
  fallback: string;
}

export interface ClassificationResult {
  category: string;
  /** 0..1 */
  confidence: number;
  codeRelated: boolean;
  priority?: TicketPriority;
  /** Short, redacted summary that is safe to show outside the help desk. */
  summary?: string;
  tags?: string[];
  details?: Record<string, string>;
}

/** Extra metadata a classifier may return about how it reached its result. */
export interface ClassifierMeta {
  provider?: string;
  model?: string;
  logId?: string;
}

export interface Classifier<Env = unknown> {
  /** Unique, [a-z0-9-]; also the Workflow step name `classify:<name>`. */
  name: string;
  /** Return null to abstain. Throwing is recorded as an error and the cascade moves on. */
  classify(input: ClassificationInput, ctx: { env: Env }): Promise<(ClassificationResult & { meta?: ClassifierMeta }) | null>;
}

export interface ClassificationConfig<Env = unknown> {
  categories: CategoryDef[];
  /** Category used when nothing is confident enough. Default "other". */
  fallback?: string;
  /** First result with confidence ≥ this wins. Default 0.75. */
  acceptAt?: number;
  /** Tried in order, cheapest first. */
  classifiers: Classifier<Env>[];
  /** Also classify customer replies on existing tickets. Default false. */
  reclassifyOnReply?: boolean;
  /** Max characters of subject+body sent to classifiers. Default 8000. */
  maxInputChars?: number;
}

/**
 * Serializable copy of the effective config, taken in the first classification step. Every later
 * decision reads this snapshot, so a Workflow replaying after a config change stays consistent.
 */
export interface ClassificationSnapshot {
  categories: CategoryDef[];
  fallback: string;
  acceptAt: number;
  classifierNames: string[];
  maxInputChars: number;
}

export interface ClassificationAttempt {
  classifier: string;
  result: ClassificationResult | null;
  error?: string;
  meta?: ClassifierMeta;
  durationMs: number;
}

export interface ClassificationOutcome {
  category: string;
  confidence: number;
  codeRelated: boolean;
  priority?: TicketPriority;
  summary?: string;
  tags?: string[];
  details?: Record<string, string>;
  /** Classifier whose result was accepted; null when the fallback was used. */
  acceptedBy: string | null;
  attempts: ClassificationAttempt[];
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { id: "bug", description: "Software defect: an error, crash, outage or something behaving incorrectly", codeRelated: true },
  { id: "feature", description: "Request for new functionality or an improvement", codeRelated: true },
  { id: "question", description: "How-to, usage or general question" },
  { id: "billing", description: "Invoices, payments, refunds, pricing or plans" },
  { id: "account", description: "Login, access, passwords or account changes" },
  { id: "spam", description: "Unsolicited, marketing or irrelevant mail" },
];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function snapshotConfig(c: ClassificationConfig<any>): ClassificationSnapshot {
  const fallback = c.fallback ?? "other";
  const names = new Set<string>();
  for (const cat of c.categories) {
    if (!ID_RE.test(cat.id)) throw new Error(`Invalid category id "${cat.id}"`);
  }
  for (const cl of c.classifiers) {
    if (!ID_RE.test(cl.name)) throw new Error(`Invalid classifier name "${cl.name}"`);
    if (names.has(cl.name)) throw new Error(`Duplicate classifier "${cl.name}"`);
    names.add(cl.name);
  }
  return {
    categories: c.categories.map((x) => ({ id: x.id, description: x.description, codeRelated: !!x.codeRelated })),
    fallback,
    acceptAt: c.acceptAt ?? 0.75,
    classifierNames: [...names],
    maxInputChars: c.maxInputChars ?? 8000,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation + decision
// ---------------------------------------------------------------------------------------------

const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

/** Validate an untrusted result (e.g. LLM JSON) against the snapshot. Throws with readable errors. */
export function validateResult(raw: unknown, snap: ClassificationSnapshot): ClassificationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("result must be a JSON object");
  const r = raw as Record<string, unknown>;
  const ids = [...snap.categories.map((c) => c.id), snap.fallback];
  const category = typeof r.category === "string" ? r.category.trim().toLowerCase() : "";
  if (!ids.includes(category)) errors.push(`category must be one of: ${ids.join(", ")}`);
  const confidence = typeof r.confidence === "number" ? r.confidence : Number(r.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push("confidence must be a number between 0 and 1");
  const priority = r.priority == null ? undefined : String(r.priority).toLowerCase();
  if (priority !== undefined && !PRIORITIES.includes(priority as TicketPriority)) errors.push(`priority must be one of: ${PRIORITIES.join(", ")}`);
  if (errors.length) throw new Error(errors.join("; "));
  const catDef = snap.categories.find((c) => c.id === category);
  return {
    category,
    confidence,
    codeRelated: typeof r.codeRelated === "boolean" ? r.codeRelated : !!catDef?.codeRelated,
    ...(priority ? { priority: priority as TicketPriority } : {}),
    ...(typeof r.summary === "string" && r.summary.trim() ? { summary: r.summary.trim().slice(0, 1000) } : {}),
    ...(Array.isArray(r.tags) ? { tags: r.tags.filter((t): t is string => typeof t === "string").slice(0, 10) } : {}),
    ...(r.details && typeof r.details === "object" && !Array.isArray(r.details)
      ? { details: Object.fromEntries(Object.entries(r.details).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k.slice(0, 64), (v as string).slice(0, 2000)])) }
      : {}),
  };
}

export const isAccepted = (a: ClassificationAttempt, snap: ClassificationSnapshot) =>
  !!a.result && a.result.confidence >= snap.acceptAt;

/**
 * Pick the outcome from the attempts so far: the first accepted result, else fall back.
 * Lower-confidence results still contribute a summary/priority if the accepted one lacks them.
 */
export function decide(attempts: ClassificationAttempt[], snap: ClassificationSnapshot): ClassificationOutcome {
  const accepted = attempts.find((a) => isAccepted(a, snap));
  const best = accepted?.result;
  const summary = best?.summary ?? attempts.find((a) => a.result?.summary)?.result?.summary;
  if (best) {
    return {
      category: best.category,
      confidence: best.confidence,
      codeRelated: best.codeRelated,
      ...(best.priority ? { priority: best.priority } : {}),
      ...(summary ? { summary } : {}),
      ...(best.tags ? { tags: best.tags } : {}),
      ...(best.details ? { details: best.details } : {}),
      acceptedBy: accepted!.classifier,
      attempts,
    };
  }
  return {
    category: snap.fallback,
    confidence: 0,
    codeRelated: false,
    ...(summary ? { summary } : {}),
    acceptedBy: null,
    attempts,
  };
}

// ---------------------------------------------------------------------------------------------
// Input preparation: redaction + truncation (docs/AI-PIPELINE.md §7)
// ---------------------------------------------------------------------------------------------

const REDACTIONS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private-key]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, "[jwt]"],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g, "[api-key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[github-token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[slack-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[aws-key]"],
  [/\b(?:bearer|token|password|passwd|pwd|secret|api[-_ ]?key)\s*[:=]\s*\S+/gi, "[credential]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\b/g, "[iban]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[card-or-number]"],
  [/(?:\+\d{1,3}[ .-]?)?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}\b/g, "[phone]"],
  [/\b[A-Za-z0-9+/]{60,}={0,2}/g, "[blob]"],
];

/** Best-effort PII/secret redaction before content leaves the Worker. Not a guarantee. */
export function redact(text: string): string {
  return REDACTIONS.reduce((acc, [re, label]) => acc.replace(re, label), text);
}

/** Drop quoted history ("On … wrote:", "> …") and signatures ("-- "). */
export function stripQuotedAndSignature(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^-- ?$/.test(line)) break;
    if (/^On .{5,200} wrote:$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function prepareInput(
  raw: { ticketRef: string; subject: string; text: string; from: string },
  snap: ClassificationSnapshot,
): ClassificationInput {
  const body = redact(stripQuotedAndSignature(raw.text)).slice(0, snap.maxInputChars);
  return {
    ticketRef: raw.ticketRef,
    subject: redact(raw.subject).slice(0, 300),
    text: body,
    from: raw.from.split("@")[1] ? `*@${raw.from.split("@")[1]}` : "[unknown]",
    categories: snap.categories,
    fallback: snap.fallback,
  };
}

// ---------------------------------------------------------------------------------------------
// Rules classifier
// ---------------------------------------------------------------------------------------------

export interface Rule {
  category: string;
  confidence: number;
  codeRelated?: boolean;
  priority?: TicketPriority;
  /** Any of these patterns matching subject or body triggers the rule. */
  patterns: RegExp[];
  /** Restrict to sender domain pattern (matched against "*@domain"). */
  from?: RegExp;
}

export const DEFAULT_RULES: Rule[] = [
  {
    category: "bug",
    confidence: 0.9,
    codeRelated: true,
    priority: "high",
    patterns: [
      /\b(?:TypeError|ReferenceError|SyntaxError|NullPointerException|Segmentation fault|Traceback \(most recent call last\)|Unhandled(?:Promise)?Rejection|panic:)/,
      /\bat [\w$.<>]+ \(?[\w./\\-]+:\d+:\d+\)?/, // JS stack frame
      /\bHTTP\/?\d?\.?\d? ?5\d\d\b|\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
      /\b(?:stack ?trace|exception thrown|crash(?:es|ed)? (?:on|when)|error code \w+)\b/i,
    ],
  },
  {
    category: "billing",
    confidence: 0.8,
    patterns: [/\b(?:invoice|refund|charged twice|double charged|billing|receipt|credit card was charged|subscription (?:fee|charge))\b/i],
  },
  {
    category: "account",
    confidence: 0.8,
    patterns: [/\b(?:reset (?:my )?password|can'?t log ?in|cannot log ?in|locked out|2fa|two[- ]factor|delete my account)\b/i],
  },
];

/** Free, deterministic keyword/regex classifier. Abstains when nothing matches. */
export function rulesClassifier(opts: { name?: string; rules?: Rule[] } = {}): Classifier {
  const rules = opts.rules ?? DEFAULT_RULES;
  return {
    name: opts.name ?? "rules",
    async classify(input) {
      const haystack = `${input.subject}\n${input.text}`;
      const known = new Set([...input.categories.map((c) => c.id), input.fallback]);
      for (const r of rules) {
        if (!known.has(r.category)) continue;
        if (r.from && !r.from.test(input.from)) continue;
        if (r.patterns.some((p) => p.test(haystack))) {
          const def = input.categories.find((c) => c.id === r.category);
          return {
            category: r.category,
            confidence: r.confidence,
            codeRelated: r.codeRelated ?? !!def?.codeRelated,
            ...(r.priority ? { priority: r.priority } : {}),
            tags: ["rule-match"],
          };
        }
      }
      return null;
    },
  };
}
