// Demo sign-in: sets the cookie identityFromRequest reads. Replace with your app's auth.
// Deliberately minimal: no Secure flag (works on http://localhost) and no CSRF check, because
// anyone may pick any demo user anyway. Your real session needs both.
import { createFileRoute } from "@tanstack/react-router";
import { COOKIE, DEMO_USERS, identityFromRequest } from "../../lib/identity";

export const Route = createFileRoute("/api/session")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const u = identityFromRequest(request);
        return Response.json({ user: u && { id: u.id, label: u.label, role: u.role, partition: u.partition }, users: DEMO_USERS.map(({ id, label }) => ({ id, label })) });
      },
      POST: async ({ request }) => {
        const { id } = (await request.json().catch(() => ({}))) as { id?: string };
        const user = DEMO_USERS.find((u) => u.id === id);
        const cookie = user ? `${COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Lax` : `${COOKIE}=; Path=/; Max-Age=0`;
        return new Response(null, { status: 204, headers: { "set-cookie": cookie } });
      },
    },
  },
});
