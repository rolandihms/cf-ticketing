import { trustedHeaders } from "@rolandihms/helpdesk-client/server";

export interface DevIdentityEnv {
  DEV_AGENT_EMAIL?: string;
  TRUSTED_PRINCIPAL?: string;
  HELPDESK_SERVICE_KEY?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Local development only. `vite dev` has no Cloudflare Access in front of it, so a localhost request is
 * signed in as DEV_AGENT_EMAIL (an admin who sees everything) through the trusted-principal path.
 * Off unless DEV_AGENT_EMAIL, TRUSTED_PRINCIPAL=on and HELPDESK_SERVICE_KEY are all set, which only
 * .dev.vars does. A deployed Worker is reached on its own hostname, never localhost.
 */
export function withDevIdentity(request: Request, env: DevIdentityEnv): Request {
  const email = env.DEV_AGENT_EMAIL?.trim().toLowerCase();
  if (!email || env.TRUSTED_PRINCIPAL !== "on" || !env.HELPDESK_SERVICE_KEY) return request;
  if (!LOCAL_HOSTS.has(new URL(request.url).hostname)) return request;
  const headers = new Headers(request.headers);
  for (const [k, v] of Object.entries(
    trustedHeaders(env.HELPDESK_SERVICE_KEY, { externalId: `dev:${email}`, email, role: "admin", partition: null }),
  )) {
    headers.set(k, v);
  }
  return new Request(request, { headers });
}
