// @rolandihms/helpdesk-client: a small typed client for the help desk API. No framework, no dependencies at
// runtime: works in browsers, Workers and Node. Bring your own UI (docs/EMBEDDING.md).
import type { Agent, AgentRole, Mailbox, Message, Principal, Ticket, TicketDetail, TicketFilter, TicketPage, TicketPatch, TicketStatus } from "./types";

export type * from "./types";

/** A non-2xx answer from the API. `status` is the HTTP status (404 outside your partition, 409 on conflicts…). */
export class HelpdeskApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HelpdeskApiError";
  }
}

export interface ClientOptions {
  /**
   * Where the API is mounted. In a browser this is usually your own app's proxy (e.g.
   * "/api/v1/helpdesk"); server-side it can be the help desk Worker itself. Paths are appended:
   * "<baseUrl>/tickets". Relative URLs are allowed in browsers.
   */
  baseUrl: string;
  /** Defaults to globalThis.fetch. Server-side, pass a service binding: (r) => env.HELPDESK.fetch(r). */
  fetch?: (request: Request) => Response | Promise<Response>;
  /** Extra headers per request (auth, trusted principal from ./server, …). */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

export type HelpdeskClient = ReturnType<typeof createHelpdeskClient>;

export function createHelpdeskClient(opts: ClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((r: Request) => globalThis.fetch(r));
  // Resolves relative baseUrls in browsers; elsewhere baseUrl must be absolute.
  const origin = (globalThis as { location?: { href: string } }).location?.href ?? "http://localhost";

  async function send(method: string, path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown; headers?: Record<string, string> } = {}) {
    const url = new URL(base + path, origin);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const headers = new Headers(typeof opts.headers === "function" ? await opts.headers() : opts.headers);
    for (const [k, v] of Object.entries(init.headers ?? {})) headers.set(k, v);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const res = await doFetch(
      new Request(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new HelpdeskApiError(res.status, err?.error ?? `HTTP ${res.status}`);
    }
    return res;
  }
  const json = async <T>(method: string, path: string, init?: Parameters<typeof send>[2]) => (await (await send(method, path, init)).json()) as T;
  const enc = encodeURIComponent;

  return {
    /** Who the API thinks you are (role, partition, agent record). */
    me: () => json<Principal>("GET", "/me"),

    tickets: {
      list: (f: TicketFilter = {}) =>
        json<TicketPage>("GET", "/tickets", {
          query: { ...f, status: Array.isArray(f.status) ? f.status.join(",") : f.status },
        }),
      get: (ref: string) => json<TicketDetail>("GET", `/tickets/${enc(ref)}`),
      /** Compare-and-set: 409 (HelpdeskApiError) if someone changed the same field meanwhile; reload and retry. */
      update: (ref: string, patch: TicketPatch) => json<Ticket>("PATCH", `/tickets/${enc(ref)}`, { body: patch }),
      /** Internal note, never emailed. */
      addNote: (ref: string, text: string) => json<Message>("POST", `/tickets/${enc(ref)}/notes`, { body: { text } }),
      /**
       * Email the customer, threaded into their conversation. The ticket moves to `status` (default
       * "pending"). Pass an idempotencyKey (e.g. crypto.randomUUID() per compose) so retries never send twice.
       */
      reply: (ref: string, input: { text: string; status?: TicketStatus; idempotencyKey?: string }) =>
        json<{ message: Message; ticket: Ticket }>("POST", `/tickets/${enc(ref)}/replies`, {
          body: { text: input.text, ...(input.status ? { status: input.status } : {}) },
          headers: input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {},
        }),
    },

    messages: {
      /** Full text of a message, note or reply. */
      text: async (id: string) => (await send("GET", `/messages/${enc(id)}/text`)).text(),
    },

    attachments: {
      /** The download URL, for <a href download>. Same-origin proxies keep the user's cookies. */
      url: (id: string) => `${base}/attachments/${enc(id)}`,
      download: async (id: string) => (await send("GET", `/attachments/${enc(id)}`)).blob(),
    },

    agents: {
      list: async () => (await json<{ agents: Agent[] }>("GET", "/agents")).agents,
      create: (input: { email: string; name: string; role?: AgentRole; partition?: string | null }) => json<Agent>("POST", "/agents", { body: input }),
      update: (id: string, patch: { name?: string; role?: AgentRole; active?: boolean; partition?: string | null }) =>
        json<Agent>("PATCH", `/agents/${enc(id)}`, { body: patch }),
    },

    mailboxes: {
      list: async () => (await json<{ mailboxes: Mailbox[] }>("GET", "/mailboxes")).mailboxes,
      create: (input: { address: string; name: string; refPrefix: string; fromName?: string; partition?: string | null }) =>
        json<Mailbox>("POST", "/mailboxes", { body: input }),
    },
  };
}
