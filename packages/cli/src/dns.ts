/** Cloudflare Email Routing's MX hosts. */
const CF_MX = /\.mx\.cloudflare\.net\.?$/i;

export interface MxCheck {
  records: string[];
  /** MX records that point somewhere other than Cloudflare Email Routing. */
  foreign: string[];
}

/** Look up MX records over DNS-over-HTTPS (works without a local resolver). */
export async function checkMx(domain: string, doFetch: typeof fetch = fetch): Promise<MxCheck> {
  const res = await doFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DNS lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
  const records = (body.Answer ?? []).filter((a) => a.type === 15).map((a) => a.data.split(/\s+/).pop()!.toLowerCase());
  return { records, foreign: records.filter((r) => !CF_MX.test(r)) };
}
