// The browser-side client: everything goes through this app's own proxy route (same origin, the
// user's session cookie), never directly to the help desk.
import { createHelpdeskClient } from "@cf-helpdesk/client";

export const helpdesk = createHelpdeskClient({ baseUrl: "/api/helpdesk" });
