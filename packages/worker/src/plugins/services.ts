import type { HelpdeskEnv } from "../env";
import type { TicketServices } from "@rolandihms/helpdesk-core";
import { withRepo } from "@rolandihms/helpdesk-db";

/** TicketServices for plugins, backed by the configured database. Each call opens/closes a repo. */
export function ticketServices(env: HelpdeskEnv, ticketId: string, actor: string): TicketServices {
  return {
    addEvent: (type, data) => withRepo(env, (r) => r.addEvent(ticketId, type, actor, data)),
    getLink: (provider) => withRepo(env, (r) => r.getLink(ticketId, provider)),
    saveLink: (link) => withRepo(env, (r) => r.saveLink(ticketId, link)),
  };
}
