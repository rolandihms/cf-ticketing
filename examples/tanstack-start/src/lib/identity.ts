// STAND-IN FOR YOUR AUTH. A real host resolves the user from its own session (better-auth, …) and
// maps it to a HostIdentity. Here a cookie picks one of a few demo users, so you can see how
// partitions and roles behave. Server-only.
import type { HostIdentity } from "@cf-helpdesk/client/server";

export const DEMO_USERS: (HostIdentity & { id: string; label: string })[] = [
  { id: "staff", label: "Sam (staff, all companies)", externalId: "demo-staff", email: "sam@host.example", name: "Sam", role: "admin", partition: null },
  { id: "acme-agent", label: "Ann (agent, Acme)", externalId: "demo-ann", email: "ann@host.example", name: "Ann", role: "agent", partition: "company:acme" },
  { id: "globex-agent", label: "Gus (agent, Globex)", externalId: "demo-gus", email: "gus@host.example", name: "Gus", role: "agent", partition: "company:globex" },
];

export const COOKIE = "hd_demo_user";

export function identityFromRequest(request: Request): (typeof DEMO_USERS)[number] | null {
  const id = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return DEMO_USERS.find((u) => u.id === id) ?? null;
}
