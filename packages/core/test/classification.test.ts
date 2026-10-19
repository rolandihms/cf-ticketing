import { describe, expect, it } from "vitest";
import {
  type ClassificationAttempt,
  DEFAULT_CATEGORIES,
  decide,
  llmClassifier,
  type LlmProvider,
  parseJsonLoose,
  prepareInput,
  redact,
  rulesClassifier,
  snapshotConfig,
  stripQuotedAndSignature,
  validateResult,
} from "../src";

const snap = snapshotConfig({ categories: DEFAULT_CATEGORIES, classifiers: [rulesClassifier()] });
const input = (subject: string, text: string) => prepareInput({ ticketRef: "T-1", subject, text, from: "jane@cust.example" }, snap);

describe("snapshot", () => {
  it("captures defaults and rejects bad ids", () => {
    expect(snap).toMatchObject({ fallback: "other", acceptAt: 0.75, classifierNames: ["rules"], maxInputChars: 8000 });
    expect(() => snapshotConfig({ categories: [{ id: "Bad Id", description: "" }], classifiers: [] })).toThrow();
    expect(() => snapshotConfig({ categories: [], classifiers: [rulesClassifier(), rulesClassifier()] })).toThrow(/Duplicate/);
  });
});

describe("redaction and input prep", () => {
  it("removes contact details and secrets", () => {
    const out = redact("mail jane.doe@x.com or call +27 82 555 1234, key sk-live-abcdefghijklmnop1234 token=hunter2 ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toMatch(/jane\.doe|555 1234|sk-live|hunter2|ghp_/);
    expect(out).toContain("[email]");
  });
  it("keeps stack frames intact", () => {
    expect(redact("at handler (src/app.js:120:15)")).toBe("at handler (src/app.js:120:15)");
  });
  it("drops quoted history and signatures, hides the sender's local part", () => {
    expect(stripQuotedAndSignature("hi\n> old\nOn Mon, 1 Jan 2026 Bob wrote:\nmore")).toBe("hi");
    expect(stripQuotedAndSignature("hi\n-- \nJane Doe\nCEO")).toBe("hi");
    expect(input("x", "y").from).toBe("*@cust.example");
  });
});

describe("rules classifier", () => {
  const rules = rulesClassifier();
  it("detects code bugs from stack traces and 5xx errors", async () => {
    const r = await rules.classify(input("App broken", "I get TypeError: cannot read properties of undefined\n at render (app.js:12:4)"), { env: {} });
    expect(r).toMatchObject({ category: "bug", codeRelated: true, priority: "high" });
    expect((await rules.classify(input("Down", "The site returns 502 Bad Gateway"), { env: {} }))?.category).toBe("bug");
  });
  it("treats billing/account keywords as hints below acceptAt, so the LLM decides", async () => {
    const hint = await rules.classify(input("Invoice PDF download returns a blank file", "every invoice downloads as 0 bytes"), { env: {} });
    expect(hint).toMatchObject({ category: "billing" });
    expect(hint!.confidence).toBeLessThan(snap.acceptAt);
  });

  it("detects billing and account, abstains otherwise", async () => {
    expect((await rules.classify(input("Refund please", "I was charged twice"), { env: {} }))?.category).toBe("billing");
    expect((await rules.classify(input("Help", "I can't log in"), { env: {} }))?.category).toBe("account");
    expect(await rules.classify(input("Hello", "How do I export a report?"), { env: {} })).toBeNull();
  });
  it("ignores rules for categories this deployment doesn't have", async () => {
    const s2 = snapshotConfig({ categories: [{ id: "question", description: "q" }], classifiers: [] });
    const i = prepareInput({ ticketRef: "T", subject: "Refund", text: "invoice", from: "a@b.c" }, s2);
    expect(await rules.classify(i, { env: {} })).toBeNull();
  });
});

describe("validation and decision", () => {
  it("validates enum, confidence and priority", () => {
    expect(validateResult({ category: "BUG", confidence: 0.8, priority: "High" }, snap)).toMatchObject({ category: "bug", codeRelated: true, priority: "high" });
    expect(() => validateResult({ category: "weather", confidence: 2 }, snap)).toThrow(/category must be one of.*confidence/);
    expect(() => validateResult("nope", snap)).toThrow();
  });
  it("accepts the first confident attempt, else falls back but keeps a summary", () => {
    const low: ClassificationAttempt = { classifier: "a", durationMs: 1, result: { category: "question", confidence: 0.4, codeRelated: false, summary: "asks" } };
    const high: ClassificationAttempt = { classifier: "b", durationMs: 1, result: { category: "bug", confidence: 0.9, codeRelated: true } };
    expect(decide([low, high], snap)).toMatchObject({ category: "bug", acceptedBy: "b", summary: "asks" });
    expect(decide([low, { classifier: "c", durationMs: 1, result: null, error: "boom" }], snap)).toMatchObject({ category: "other", acceptedBy: null, confidence: 0, summary: "asks" });
  });
});

describe("llm classifier", () => {
  const fake = (replies: string[]): LlmProvider & { calls: number } => {
    const p = {
      id: "fake",
      model: "fake-1",
      calls: 0,
      async chat() {
        return { text: replies[p.calls++]!, provider: "fake", model: "fake-1" };
      },
    };
    return p;
  };
  it("parses fenced JSON and records provider metadata", async () => {
    const llm = llmClassifier({ provider: () => fake(['```json\n{"category":"question","confidence":0.82,"codeRelated":false,"priority":"low","summary":"How to export"}\n```']) });
    expect(await llm.classify(input("Export", "how?"), { env: {} })).toMatchObject({ category: "question", confidence: 0.82, meta: { provider: "fake", model: "fake-1" } });
  });
  it("retries once with validation errors, then throws", async () => {
    const p = fake(['{"category":"weather","confidence":0.9}', '{"category":"bug","confidence":0.9,"codeRelated":true}']);
    expect((await llmClassifier({ provider: () => p }).classify(input("x", "y"), { env: {} }))?.category).toBe("bug");
    expect(p.calls).toBe(2);
    await expect(llmClassifier({ provider: () => fake(["nope", "still nope"]) }).classify(input("x", "y"), { env: {} })).rejects.toThrow(/failed validation/);
  });
  it("abstains when no provider is available", async () => {
    expect(await llmClassifier({ provider: () => null }).classify(input("x", "y"), { env: {} })).toBeNull();
  });
  it("parses loose JSON", () => {
    expect(parseJsonLoose('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  });
});
