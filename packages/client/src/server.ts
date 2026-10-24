// @cf-helpdesk/client/server: for your app's backend, which has already authenticated the user and
// tells the help desk who they are (trusted principal, docs/EMBEDDING.md). Never ship this to a browser.

/** Who the current user is, as your app knows it. */
export interface HostIdentity {
  /** Your user id. */
  externalId: string;
  email: string;
  name?: string;
  role: "admin" | "agent";
  /** The tenant this request is for (e.g. "company:42"), or null for staff who see every tenant. */
  partition: string | null;
}

/** Headers that authenticate a request as `identity`. Send only over a service binding or private network. */
export function trustedHeaders(serviceKey: string, identity: HostIdentity): Record<string, string> {
  if (!serviceKey) throw new Error("trustedHeaders: serviceKey is empty");
  if (!("partition" in identity)) throw new Error("trustedHeaders: identity.partition is required (null = every partition)");
  return { "x-helpdesk-service-key": serviceKey, "x-helpdesk-principal": JSON.stringify(identity) };
}

/** Headers a browser must never be able to set (or leak) on the forwarded request. */
const STRIP = /^(x-helpdesk-|cf-access-|cookie$|authorization$)/i;

export interface ForwardOptions {
  /** The help desk: a service binding (recommended) or its base URL. */
  target: { fetch(request: Request): Response | Promise<Response> } | string;
  serviceKey: string;
  identity: HostIdentity;
  /** The path your app mounts the proxy at, e.g. "/api/v1/helpdesk". It maps to the help desk's "/api". */
  mountPath: string;
}

/**
 * Forward a browser request from your app to the help desk as the given user. Works in any
 * framework that speaks Request/Response (Hono, TanStack Start, Next.js, Remix, plain Workers):
 *
 *   app.all("/api/v1/helpdesk/*", (c) => forwardToHelpdesk(c.req.raw, { target: c.env.HELPDESK,
 *     serviceKey: c.env.HELPDESK_SERVICE_KEY, identity: toIdentity(c.get("user")), mountPath: "/api/v1/helpdesk" }));
 *
 * Client-sent X-Helpdesk-*, Cf-Access-*, Cookie and Authorization headers are dropped.
 */
export async function forwardToHelpdesk(request: Request, opts: ForwardOptions): Promise<Response> {
  const mount = opts.mountPath.replace(/\/+$/, "");
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${mount}/`)) return Response.json({ error: "not found" }, { status: 404 });
  const rest = url.pathname.slice(mount.length);
  const base = typeof opts.target === "string" ? opts.target.replace(/\/+$/, "") : "https://helpdesk.internal";
  const target = new URL(`${base}/api${rest}${url.search}`);

  const headers = new Headers();
  request.headers.forEach((v, k) => {
    if (!STRIP.test(k) && k !== "host") headers.set(k, v);
  });
  for (const [k, v] of Object.entries(trustedHeaders(opts.serviceKey, opts.identity))) headers.set(k, v);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const forwarded = new Request(target, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined, redirect: "manual" });
  const res = typeof opts.target === "string" ? await fetch(forwarded) : await opts.target.fetch(forwarded);
  // Return a fresh response (mutable headers for the host's middleware), minus hop-specific headers.
  const out = new Response(res.body, res);
  out.headers.delete("set-cookie");
  return out;
}
