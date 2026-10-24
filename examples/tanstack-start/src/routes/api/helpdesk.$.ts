// The proxy: this app's session → a trusted identity → the help desk, over the service binding.
import { forwardToHelpdesk } from "@cf-helpdesk/client/server";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { identityFromRequest } from "../../lib/identity";

async function proxy({ request }: { request: Request }) {
  const user = identityFromRequest(request);
  if (!user) return Response.json({ error: "sign in first" }, { status: 401 });
  const { id: _id, label: _label, ...identity } = user;
  return forwardToHelpdesk(request, {
    target: env.HELPDESK_URL || env.HELPDESK,
    serviceKey: env.HELPDESK_SERVICE_KEY,
    identity,
    mountPath: "/api/helpdesk",
  });
}

export const Route = createFileRoute("/api/helpdesk/$")({
  server: { handlers: { GET: proxy, HEAD: proxy, POST: proxy, PATCH: proxy } },
});
