import type { Message, TicketDetail, TicketPatch, TicketPriority, TicketStatus } from "@rolandihms/helpdesk-client";
import { HelpdeskApiError } from "@rolandihms/helpdesk-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { agentsQuery, ago, errorText, fullDate, helpdesk } from "../api";
import { PRIORITIES, STATUS_LABEL, STATUSES, StatusPill } from "../bits";

const route = getRouteApi("/tickets/$ref");

export function TicketPage() {
  const { ref } = route.useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["ticket", ref], queryFn: () => helpdesk.tickets.get(ref), refetchInterval: 30_000 });
  const agents = useQuery(agentsQuery);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["ticket", ref] }), qc.invalidateQueries({ queryKey: ["tickets"] })]);
  const update = useMutation({ mutationFn: (patch: TicketPatch) => helpdesk.tickets.update(ref, patch), onSettled: refresh });

  if (detail.error) {
    const missing = detail.error instanceof HelpdeskApiError && detail.error.status === 404;
    return (
      <main className="content narrow">
        <BackLink />
        <p className="alert">{missing ? `There is no ticket ${ref}.` : errorText(detail.error)}</p>
      </main>
    );
  }
  if (!detail.data) return <main className="content narrow muted">Loading…</main>;
  const { ticket, requester, messages, attachments, events } = detail.data;

  return (
    <div className="ticket">
      <main className="content">
        <BackLink />
        <div className="ticket-head">
          <span className="ref">{ticket.ref}</span>
          <StatusPill status={ticket.status} />
          <h1>{ticket.subject || "(no subject)"}</h1>
        </div>

        <ol className="thread">
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} attachments={attachments.filter((a) => a.message_id === m.id)} />
          ))}
        </ol>

        {/* key: a draft and its idempotency key never carry over to another ticket */}
        <Compose key={ref} ticketRef={ref} requester={requester?.email} onDone={refresh} />

        <details className="history">
          <summary>History ({events.length})</summary>
          <ul>
            {events.map((e) => (
              <li key={e.id}>
                <time className="muted">{fullDate(e.created_at)}</time> <code>{e.type}</code> by {e.actor}
                {e.data_json ? <span className="muted"> {e.data_json}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      </main>

      <aside className="panel" aria-label="Ticket details">
        <fieldset disabled={update.isPending}>
          <label>
            Status
            <select value={ticket.status} onChange={(e) => update.mutate({ status: e.target.value as TicketStatus })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={ticket.priority} onChange={(e) => update.mutate({ priority: e.target.value as TicketPriority })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0]!.toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assignee
            <select value={ticket.assigneeId ?? ""} onChange={(e) => update.mutate({ assignee: e.target.value || null })}>
              <option value="">Unassigned</option>
              {agents.data
                ?.filter((a) => a.active || a.id === ticket.assigneeId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <button type="button" className="btn small" onClick={() => update.mutate({ assignee: "me" })}>
            Assign to me
          </button>
        </fieldset>
        {update.error ? <p className="alert">{errorText(update.error)}</p> : null}

        <dl className="facts">
          <dt>Requester</dt>
          <dd>
            {requester?.name ? (
              <>
                {requester.name}
                <br />
              </>
            ) : null}
            <span className="muted">{requester?.email ?? "unknown"}</span>
          </dd>
          <dt>Category</dt>
          <dd>
            {ticket.category ?? "Not classified"}
            {ticket.categoryConfidence ? <span className="muted"> ({Math.round(ticket.categoryConfidence * 100)}%)</span> : null}
          </dd>
          {ticket.summary ? (
            <>
              <dt>Summary</dt>
              <dd>{ticket.summary}</dd>
            </>
          ) : null}
          <dt>Created</dt>
          <dd>{fullDate(ticket.createdAt)}</dd>
          <dt>Updated</dt>
          <dd title={fullDate(ticket.updatedAt)}>{ago(ticket.updatedAt)}</dd>
        </dl>
      </aside>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/" className="back">
      ← Tickets
    </Link>
  );
}

const KIND_LABEL: Record<string, string> = { customer: "Customer", ack: "Automatic acknowledgement", agent_reply: "Reply", note: "Internal note" };

function MessageItem({ message: m, attachments }: { message: Message; attachments: TicketDetail["attachments"] }) {
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const truncated = full === null && (m.text_preview?.length ?? 0) >= 500;
  return (
    <li className={`msg msg-${m.direction} kind-${m.kind}`}>
      <div className="msg-head">
        <strong>{KIND_LABEL[m.kind] ?? m.kind}</strong>
        <span className="muted">{m.from_addr}</span>
        {m.sender_verified === false ? (
          <span className="tag warn" title="DMARC did not prove this sender. The From address may be forged.">
            Unverified sender
          </span>
        ) : null}
        <span className="spacer" />
        <time className="muted" title={fullDate(m.created_at)}>
          {ago(m.created_at)}
        </time>
      </div>
      <div className="msg-body">{full ?? m.text_preview ?? ""}</div>
      {truncated ? (
        <button
          type="button"
          className="btn ghost small"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              setFull(await helpdesk.messages.text(m.id));
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? "Loading…" : "Show full message"}
        </button>
      ) : null}
      {attachments.length ? (
        <ul className="attachments">
          {attachments.map((a) => (
            <li key={a.id}>
              <a href={helpdesk.attachments.url(a.id)} download>
                📎 {a.filename ?? "attachment"}
              </a>{" "}
              <span className="muted">{Math.ceil(a.size / 1024)} KB</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Compose({ ticketRef, requester, onDone }: { ticketRef: string; requester: string | undefined; onDone: () => Promise<unknown> }) {
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [after, setAfter] = useState<TicketStatus>("pending");
  // One idempotency key per composed reply: a retry after a network error never emails twice.
  const key = useRef(crypto.randomUUID());
  const send = useMutation({
    mutationFn: async (): Promise<unknown> =>
      mode === "reply" ? helpdesk.tickets.reply(ticketRef, { text, status: after, idempotencyKey: key.current }) : helpdesk.tickets.addNote(ticketRef, text),
    onSuccess: async () => {
      setText("");
      key.current = crypto.randomUUID();
      await onDone();
    },
  });
  return (
    <form
      className={`compose compose-${mode}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) send.mutate();
      }}
    >
      <div className="tabs" role="tablist" aria-label="Message type">
        <button type="button" role="tab" aria-selected={mode === "reply"} onClick={() => setMode("reply")}>
          Reply
        </button>
        <button type="button" role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")}>
          Internal note
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder={mode === "reply" ? `Emailed to ${requester ?? "the customer"}` : "Only agents see notes"}
        aria-label={mode === "reply" ? "Reply" : "Note"}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) send.mutate();
        }}
      />
      <div className="compose-actions">
        {mode === "reply" ? (
          <label className="inline">
            then set status
            <select value={after} onChange={(e) => setAfter(e.target.value as TicketStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="spacer" />
        <button type="submit" className="btn primary" disabled={send.isPending || !text.trim()}>
          {send.isPending ? "Sending…" : mode === "reply" ? "Send reply" : "Add note"}
        </button>
      </div>
      {send.error ? <p className="alert">{errorText(send.error)}</p> : null}
    </form>
  );
}
