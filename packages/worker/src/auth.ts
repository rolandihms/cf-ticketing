import type { Agent, AgentRole } from "@rolandihms/helpdesk-core";

/** Who is calling the API. */
export interface Principal {
  kind: "service" | "agent";
  role: AgentRole;
  /** Recorded on ticket events, e.g. "agent:01H…" or "api". */
  actor: string;
  agent?: Agent;
  /** The only partition this caller may see, or null for every partition. */
  partition: string | null;
  /** How the caller signed in. */
  via: "token" | "access" | "trusted";
}

// ---------------------------------------------------------------------------------------------
// Trusted principal (docs/EMBEDDING.md): a host app that already authenticated its user calls the
// help desk over a service binding with X-Helpdesk-Service-Key and this identity header.
// ---------------------------------------------------------------------------------------------

export interface TrustedIdentity {
  /** The host's user id. */
  externalId: string;
  email: string;
  name: string;
  role: AgentRole;
  /** Required, so "every partition" is never the accidental default: null = unrestricted. */
  partition: string | null;
}

const ID_RE = /^[\x21-\x7e]{1,128}$/;

/** Parse and validate the X-Helpdesk-Principal header (JSON). Returns an error message on bad input. */
export function parseTrustedIdentity(header: string | undefined): TrustedIdentity | string {
  if (!header) return "X-Helpdesk-Principal is required";
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(header);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
  } catch {
    return "X-Helpdesk-Principal must be a JSON object";
  }
  const { externalId, email, name, role, partition } = v;
  if (typeof externalId !== "string" || !ID_RE.test(externalId)) return "externalId: 1-128 printable ASCII characters";
  if (typeof email !== "string" || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "email is invalid";
  if (name !== undefined && (typeof name !== "string" || name.length > 255)) return "name: a string up to 255 characters";
  if (role !== "admin" && role !== "agent") return 'role must be "admin" or "agent"';
  if (!("partition" in v)) return "partition is required (a string, or null for every partition)";
  if (partition !== null && (typeof partition !== "string" || !ID_RE.test(partition))) return "partition: null or 1-128 printable ASCII characters";
  return { externalId, email: email.toLowerCase(), name: (name as string | undefined)?.trim() || email.split("@")[0]!, role, partition: partition as string | null };
}

const enc = new TextEncoder();

/** Constant-time comparison of two secrets (hashes first, so lengths don't leak either). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------------------------
// Cloudflare Access JWT verification (https://developers.cloudflare.com/cloudflare-one/identity/
// authorization-cookie/validating-json/). Access sits in front of the Worker and adds the
// `Cf-Access-Jwt-Assertion` header; we verify it ourselves so the Worker can't be reached around it.
// ---------------------------------------------------------------------------------------------

interface Jwk extends JsonWebKey {
  kid: string;
}

const CERT_TTL_MS = 10 * 60 * 1000;
/** A token with an unknown `kid` may force a refetch (key rotation), but at most this often. */
const FORCED_REFETCH_MS = 60 * 1000;
const certCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

/** Access's certificate endpoint is unreachable: the API answers 503, not 401. */
export class AccessUnavailableError extends Error {}

/** "acme" or "acme.cloudflareaccess.com" or "https://acme.cloudflareaccess.com" → issuer URL. */
export function accessIssuer(teamDomain: string): string {
  const host = teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host.includes(".") ? host : `${host}.cloudflareaccess.com`}`;
}

async function getCerts(issuer: string, doFetch: typeof fetch, force = false): Promise<Jwk[]> {
  const hit = certCache.get(issuer);
  if (hit && Date.now() - hit.fetchedAt < (force ? FORCED_REFETCH_MS : CERT_TTL_MS)) return hit.keys;
  let keys: Jwk[];
  try {
    const res = await doFetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
  } catch (err) {
    if (hit) return hit.keys; // serve stale keys rather than lock everyone out
    throw new AccessUnavailableError(`Cloudflare Access certificates unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  certCache.set(issuer, { keys, fetchedAt: Date.now() });
  return keys;
}

const b64urlToBytes = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

export interface AccessClaims {
  email: string;
  sub: string;
  aud: string | string[];
  iss: string;
  exp: number;
}

/**
 * Verify an Access JWT; returns its claims or null for any bad token. Throws AccessUnavailableError
 * only when the certificates can't be fetched at all.
 */
export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string; fetch?: typeof fetch; now?: number },
): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims & { nbf?: number };
  try {
    header = b64urlJson(parts[0]!);
    claims = b64urlJson(parts[1]!);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const issuer = accessIssuer(opts.teamDomain);
  const doFetch = opts.fetch ?? fetch;
  let jwk = (await getCerts(issuer, doFetch)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getCerts(issuer, doFetch, true)).find((k) => k.kid === header.kid); // key rotation
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]!), enc.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null; // malformed or non-RSA key, bad signature encoding
  }
  if (!ok) return null;

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(opts.aud)) return null;
  if (claims.iss !== issuer) return null;
  if (typeof claims.exp !== "number" || claims.exp < now - 30) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) return null;
  if (typeof claims.email !== "string" || !claims.email.includes("@")) return null;
  return claims;
}

/** Test hook: forget cached Access certs. */
export const _clearAccessCertCache = () => certCache.clear();
