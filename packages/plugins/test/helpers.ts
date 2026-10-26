import type { ClassificationOutcome, HelpdeskEvent, HookContext, TicketLink } from "@rolandihms/helpdesk-core";

export const ticket = {
  id: "01TICKET0000000000000000AA",
  mailboxId: "mb",
  number: 3,
  ref: "IHMS-000003",
  subject: "Export to CSV does nothing",
  status: "new" as const,
  priority: "high" as const,
  requesterId: "c",
  assigneeId: null,
  createdAt: 1,
  updatedAt: 2,
  partition: null,
  category: "bug",
  categoryConfidence: 0.9,
  codeRelated: true,
  summary: "Export to CSV on the Reports page spins forever.",
};

export const bug: ClassificationOutcome = {
  category: "bug",
  confidence: 0.9,
  codeRelated: true,
  summary: "Export to CSV on the Reports page spins forever. Contact @alice or see https://evil.example #12.",
  details: { component: "Reports page", stepsToReproduce: "Open Reports, click Export", expected: "CSV download", actual: "Endless spinner" },
  acceptedBy: "llm",
  attempts: [],
};

/** Fake Workflow context: step.do memoises by name like the real engine. */
export function fakeCtx<Env>(env: Env, extra: Partial<HookContext<Env>> = {}) {
  const memo = new Map<string, unknown>();
  const links = new Map<string, TicketLink>();
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    event: "ticket.classified" as const,
    ticket,
    mailbox: { id: "mb", address: "support@ihms.dev", name: "IHMS", refPrefix: "IHMS", fromName: null, partition: null },
    message: { ingestKey: "k".repeat(64) } as HookContext["message"],
    env,
    log: () => {},
    classification: bug,
    step: {
      async do<T>(name: string, fn: () => Promise<T>) {
        if (!memo.has(name)) memo.set(name, await fn());
        return memo.get(name) as T;
      },
      async sleep() {},
    },
    services: {
      async addEvent(type: string, data?: Record<string, unknown>) {
        events.push({ type, data });
      },
      async getLink(p: string) {
        return links.get(p) ?? null;
      },
      async saveLink(l: TicketLink) {
        if (!links.has(l.provider)) links.set(l.provider, l);
        return links.get(l.provider)!;
      },
    },
    async emit(type: string, data: Record<string, unknown>) {
      emitted.push({ type, data });
    },
    ...extra,
  };
  return { ctx: ctx as HookContext<Env> & { classification: ClassificationOutcome }, memo, links, events, emitted };
}

export function eventCtx<Env>(env: Env, ev: Partial<HelpdeskEvent> = {}) {
  const f = fakeCtx(env);
  const helpdeskEvent: HelpdeskEvent = { id: "IHMS-000003:kkk:4:github.issue.created", type: "github.issue.created", occurredAt: 1_790_000_000_000, source: "github-issues", data: { number: 7 }, ...ev };
  return { ...f, ctx: { ...f.ctx, helpdeskEvent } };
}

export type Call = { url: string; init: RequestInit };
export function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
