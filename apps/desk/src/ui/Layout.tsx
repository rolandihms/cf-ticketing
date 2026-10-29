import { HelpdeskApiError } from "@rolandihms/helpdesk-client";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { errorText, meQuery } from "./api";

// Cloudflare Access's logout endpoint, on every Access-protected hostname.
const SIGN_OUT = "/cdn-cgi/access/logout";

export function Layout() {
  const me = useQuery(meQuery);

  if (me.error) {
    const status = me.error instanceof HelpdeskApiError ? me.error.status : 0;
    return (
      <div className="gate">
        <h1>{status === 403 ? "No access yet" : status === 401 ? "Please sign in" : "The help desk is unavailable"}</h1>
        <p>
          {status === 403
            ? `${errorText(me.error)}. Ask an admin to add you under Settings → Agents.`
            : status === 401
              ? "Your sign-in has expired or is missing."
              : errorText(me.error)}
        </p>
        <p>
          {status === 401 ? <a href="/">Sign in</a> : <a href={SIGN_OUT}>Sign out</a>}
        </p>
      </div>
    );
  }
  if (!me.data) return <div className="gate muted">Loading…</div>;

  const agent = me.data.agent;
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          Support desk
        </Link>
        <nav className="topnav" aria-label="Main">
          <Link to="/" activeOptions={{ exact: true, includeSearch: false }}>
            Tickets
          </Link>
          {me.data.role === "admin" ? <Link to="/settings">Settings</Link> : null}
        </nav>
        <span className="spacer" />
        <span className="who" title={agent?.email}>
          {agent?.name ?? "API"}
          {me.data.via === "trusted" ? <span className="tag">dev</span> : null}
        </span>
        {me.data.via === "access" ? (
          <a className="btn ghost small" href={SIGN_OUT}>
            Sign out
          </a>
        ) : null}
      </header>
      <Outlet />
    </div>
  );
}
