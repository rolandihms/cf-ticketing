import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./Layout";
import { Inbox, parseInboxSearch } from "./pages/Inbox";
import { Settings } from "./pages/Settings";
import { TicketPage } from "./pages/Ticket";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Layout });

const inboxRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", validateSearch: parseInboxSearch, component: Inbox });
const ticketRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tickets/$ref", component: TicketPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: Settings });

const routeTree = rootRoute.addChildren([inboxRoute, ticketRoute, settingsRoute]);

export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent", scrollRestoration: true });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
