import type { TicketFilter, TicketStatus } from "@cf-helpdesk/client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { helpdesk } from "../lib/helpdesk";
import { sessionQuery } from "./__root";

type View = "open" | "mine" | "unassigned" | "pending" | "closed" | "all";
const VIEWS: Record<View, { label: string; filter: TicketFilter }> = {
  open: { label: "Open", filter: { status: ["new", "open"] } },
  mine: { label: "Mine", filter: { assignee: "me", status: ["new", "open", "pending", "on_hold"] } },
  unassigned: { label: "Unassigned", filter: { assignee: "unassigned", status: ["new", "open"] } },
  pending: { label: "Waiting on customer", filter: { status: "pending" } },
  closed: { label: "Solved / closed", filter: { status: ["solved", "closed"] } },
  all: { label: "All", filter: {} },
};

export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): { view?: View; q?: string } => ({
    ...((s.view as View) in VIEWS ? { view: s.view as View } : {}),
    ...(typeof s.q === "string" && s.q ? { q: s.q } : {}),
  }),
  component: Inbox,
});

function Inbox() {
  const { view = "open", q } = Route.useSearch();
  const navigate = Route.useNavigate();
  const session = useQuery(sessionQuery);
  const agents = useQuery({ queryKey: ["agents"], queryFn: helpdesk.agents.list, enabled: !!session.data?.user });
  const tickets = useInfiniteQuery({
    queryKey: ["tickets", view, q],
    queryFn: ({ pageParam }) => helpdesk.tickets.list({ ...VIEWS[view].filter, q, limit: 25, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!session.data?.user,
  });

  if (session.data && !session.data.user) return <p>Choose a demo user (top right) to see their tickets.</p>;
  const agentName = (id: string | null) => (id ? (agents.data?.find((a) => a.id === id)?.name ?? "…") : "—");

  return (
    <main>
      <nav style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }} aria-label="Views">
        {(Object.keys(VIEWS) as View[]).map((v) => (
          <Link key={v} to="/" search={{ view: v, q }} aria-current={v === view ? "page" : undefined} style={{ fontWeight: v === view ? 700 : 400 }}>
            {VIEWS[v].label}
          </Link>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const q = String(new FormData(e.currentTarget).get("q") ?? "");
            navigate({ search: { view, ...(q ? { q } : {}) } });
          }}
        >
          <input name="q" defaultValue={q} placeholder="Search subject or ref" aria-label="Search" />
        </form>
      </nav>

      {tickets.error ? <p role="alert">Couldn't load tickets: {tickets.error.message}</p> : null}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th>Ref</th>
            <th>Subject</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Category</th>
            <th>Assignee</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {tickets.data?.pages
            .flatMap((p) => p.tickets)
            .map((t) => (
              <tr key={t.id} style={{ borderTop: "1px solid #ccc" }}>
                <td>
                  <Link to="/tickets/$ref" params={{ ref: t.ref }}>
                    {t.ref}
                  </Link>
                </td>
                <td>{t.subject}</td>
                <td>{t.status as TicketStatus}</td>
                <td>{t.priority}</td>
                <td>{t.category ?? "—"}</td>
                <td>{agentName(t.assigneeId)}</td>
                <td>{new Date(t.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {tickets.isPending ? <p>Loading…</p> : null}
      {tickets.data && tickets.data.pages[0]!.tickets.length === 0 ? <p>No tickets here.</p> : null}
      {tickets.hasNextPage ? (
        <button type="button" onClick={() => tickets.fetchNextPage()} disabled={tickets.isFetchingNextPage}>
          Load more
        </button>
      ) : null}
    </main>
  );
}
