import type { TicketFilter } from "@rolandihms/helpdesk-client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { agentsQuery, ago, errorText, fullDate, helpdesk } from "../api";
import { PriorityTag, StatusPill } from "../bits";

type View = "open" | "mine" | "unassigned" | "pending" | "closed" | "all";
const VIEWS: Record<View, { label: string; filter: TicketFilter }> = {
  open: { label: "Open", filter: { status: ["new", "open"] } },
  mine: { label: "Assigned to me", filter: { assignee: "me", status: ["new", "open", "pending", "on_hold"] } },
  unassigned: { label: "Unassigned", filter: { assignee: "unassigned", status: ["new", "open"] } },
  pending: { label: "Waiting on customer", filter: { status: "pending" } },
  closed: { label: "Solved and closed", filter: { status: ["solved", "closed"] } },
  all: { label: "All tickets", filter: {} },
};

export interface InboxSearch {
  view?: View;
  q?: string;
}

export function parseInboxSearch(s: Record<string, unknown>): InboxSearch {
  return {
    ...(typeof s.view === "string" && Object.hasOwn(VIEWS, s.view) ? { view: s.view as View } : {}),
    ...(typeof s.q === "string" && s.q ? { q: s.q } : {}),
  };
}

const route = getRouteApi("/");

export function Inbox() {
  const { view = "open", q } = route.useSearch();
  const navigate = route.useNavigate();
  const agents = useQuery(agentsQuery);
  const tickets = useInfiniteQuery({
    queryKey: ["tickets", view, q],
    queryFn: ({ pageParam }) => helpdesk.tickets.list({ ...VIEWS[view].filter, q, limit: 30, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });
  const agentName = (id: string | null) => (id ? (agents.data?.find((a) => a.id === id)?.name ?? "…") : null);
  const rows = tickets.data?.pages.flatMap((p) => p.tickets) ?? [];

  return (
    <div className="inbox">
      <aside className="sidebar" aria-label="Views">
        {(Object.keys(VIEWS) as View[]).map((v) => (
          <Link key={v} to="/" search={{ view: v, q }} className="side-link" aria-current={v === view ? "page" : undefined}>
            {VIEWS[v].label}
          </Link>
        ))}
      </aside>

      <main className="content">
        <div className="toolbar">
          <h1>{VIEWS[view].label}</h1>
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              const next = String(new FormData(e.currentTarget).get("q") ?? "").trim();
              navigate({ search: { view, ...(next ? { q: next } : {}) } });
            }}
          >
            <input key={q} name="q" type="search" defaultValue={q} placeholder="Search subject or ref" aria-label="Search tickets" />
          </form>
        </div>

        {tickets.error ? <p className="alert">Couldn't load tickets: {errorText(tickets.error)}</p> : null}

        <ul className="ticket-list">
          {rows.map((t) => (
            <li key={t.id}>
              <Link to="/tickets/$ref" params={{ ref: t.ref }} className="ticket-row">
                <span className="ref">{t.ref}</span>
                <span className="subject">
                  <strong>{t.subject || "(no subject)"}</strong>
                  {t.summary ? <span className="summary">{t.summary}</span> : null}
                </span>
                <span className="meta">
                  <StatusPill status={t.status} />
                  <PriorityTag priority={t.priority} />
                  {t.category ? <span className="tag">{t.category}</span> : null}
                </span>
                <span className="assignee">{agentName(t.assigneeId) ?? <span className="muted">Unassigned</span>}</span>
                <time className="when muted" dateTime={new Date(t.updatedAt).toISOString()} title={fullDate(t.updatedAt)}>
                  {ago(t.updatedAt)}
                </time>
              </Link>
            </li>
          ))}
        </ul>

        {tickets.isPending ? <p className="empty muted">Loading…</p> : null}
        {tickets.data && rows.length === 0 ? <p className="empty muted">{q ? `Nothing matches “${q}”.` : "No tickets here."}</p> : null}
        {tickets.hasNextPage ? (
          <button type="button" className="btn" onClick={() => tickets.fetchNextPage()} disabled={tickets.isFetchingNextPage}>
            {tickets.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </main>
    </div>
  );
}
