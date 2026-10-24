/// <reference types="vite/client" />
import { type QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Help desk (reference UI)" }],
  }),
  shellComponent: Shell,
  component: Root,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 960, margin: "0 auto", padding: 16 }}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Root() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <header style={{ display: "flex", gap: 16, alignItems: "baseline", borderBottom: "1px solid", paddingBottom: 8, marginBottom: 16 }}>
        <Link to="/">
          <strong>Help desk</strong>
        </Link>
        <span style={{ flex: 1 }} />
        <SessionSwitcher />
      </header>
      <Outlet />
    </QueryClientProvider>
  );
}

export interface Session {
  user: { id: string; label: string; role: string; partition: string | null } | null;
  users: { id: string; label: string }[];
}

export const sessionQuery = { queryKey: ["session"], queryFn: async (): Promise<Session> => (await fetch("/api/session")).json() };

/** Demo only: pick who you are. A real host has its own login. */
function SessionSwitcher() {
  const qc = useQueryClient();
  const { data } = useQuery(sessionQuery);
  if (!data) return null;
  const choose = async (id: string) => {
    await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    await qc.resetQueries();
  };
  return (
    <label>
      Signed in as{" "}
      <select value={data.user?.id ?? ""} onChange={(e) => choose(e.target.value)} aria-label="Demo user">
        <option value="">(nobody)</option>
        {data.users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </select>
    </label>
  );
}
