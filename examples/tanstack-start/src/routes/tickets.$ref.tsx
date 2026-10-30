import { HelpdeskApiError, type Message, type TicketDetail, type TicketPatch, type TicketPriority, type TicketStatus } from "@rolandihms/helpdesk-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { helpdesk } from "../lib/helpdesk";

const STATUSES: TicketStatus[] = ["new", "open", "pending", "on_hold", "solved", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

export const Route = createFileRoute("/tickets/$ref")({ component: TicketPage });

function TicketPage() {
  const { ref } = Route.useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["ticket", ref], queryFn: () => helpdesk.tickets.get(ref) });
  const agents = useQuery({ queryKey: ["agents"], queryFn: helpdesk.agents.list });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["ticket", ref] }), qc.invalidateQueries({ queryKey: ["tickets"] })]);

  const update = useMutation({
    mutationFn: (patch: TicketPatch) => helpdesk.tickets.update(ref, patch),
    onSettled: refresh,
  });

  if (detail.error) {
    return <p role="alert">{detail.error instanceof HelpdeskApiError && detail.error.status === 404 ? "No such ticket (or not in your company)." : detail.error.message}</p>;
  }
  if (!detail.data) return <p>Loading…</p>;
  const { ticket, requester, messages, attachments, events } = detail.data;

  return (
    <main>
      <p>
        <Link to="/">
          ← Inbox
        </Link>
      </p>
      <h1>
        {ticket.ref}: {ticket.subject}
      </h1>
      <p>
        From {requester?.name ?? ""} &lt;{requester?.email}&gt; · category {ticket.category ?? "—"}
        {ticket.summary ? ` · ${ticket.summary}` : ""}
      </p>

      <fieldset disabled={update.isPending} style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <legend>Ticket</legend>
        <label>
          Status{" "}
          <select value={ticket.status} onChange={(e) => update.mutate({ status: e.target.value as TicketStatus })}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Priority{" "}
          <select value={ticket.priority} onChange={(e) => update.mutate({ priority: e.target.value as TicketPriority })}>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Assignee{" "}
          <select value={ticket.assigneeId ?? ""} onChange={(e) => update.mutate({ assignee: e.target.value || null })}>
            <option value="">(unassigned)</option>
            {agents.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => update.mutate({ assignee: "me" })}>
          Assign to me
        </button>
      </fieldset>
      {update.error ? (
        <p role="alert">
          {update.error instanceof HelpdeskApiError && update.error.status === 409 ? "Someone else changed this ticket; reloaded." : update.error.message}
        </p>
      ) : null}

      <h2>Conversation</h2>
      <ol style={{ listStyle: "none", padding: 0 }}>
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} attachments={attachments.filter((a) => a.message_id === m.id)} />
        ))}
      </ol>

      {/* key: a draft and its idempotency key never carry over to another ticket */}
      <Compose key={ref} ticketRef={ref} onDone={refresh} />

      <details>
        <summary>History ({events.length})</summary>
        <ul>
          {events.map((e) => (
            <li key={e.id}>
              {new Date(e.created_at).toLocaleString()} · {e.type} · {e.actor}
              {e.data_json ? ` · ${e.data_json}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}

const LABEL: Record<string, string> = { customer: "Customer", ack: "Auto-acknowledgement", agent_reply: "Reply", note: "Internal note" };

function MessageItem({ message: m, attachments }: { message: Message; attachments: TicketDetail["attachments"] }) {
  const [full, setFull] = useState<string | null>(null);
  return (
    <li style={{ borderTop: "1px solid #ccc", padding: "8px 0", background: m.direction === "note" ? "#fff8dc" : undefined }}>
      <div>
        <strong>{LABEL[m.kind] ?? m.kind}</strong> · {m.from_addr} · {new Date(m.created_at).toLocaleString()}
      </div>
      <p style={{ whiteSpace: "pre-wrap" }}>{full ?? m.text_preview}</p>
      {full === null && (m.text_preview?.length ?? 0) >= 500 ? (
        <button type="button" onClick={async () => setFull(await helpdesk.messages.text(m.id))}>
          Show full message
        </button>
      ) : null}
      {attachments.length ? (
        <ul>
          {attachments.map((a) => (
            <li key={a.id}>
              <a href={helpdesk.attachments.url(a.id)} download>
                {a.filename ?? "attachment"}
              </a>{" "}
              ({a.mime_type}, {Math.ceil(a.size / 1024)} KB)
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Compose({ ticketRef, onDone }: { ticketRef: string; onDone: () => Promise<unknown> }) {
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
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) send.mutate();
      }}
      style={{ display: "grid", gap: 8, marginBlock: 16 }}
    >
      <div role="radiogroup" aria-label="Message type">
        <label>
          <input type="radio" checked={mode === "reply"} onChange={() => setMode("reply")} /> Reply to customer (emailed)
        </label>{" "}
        <label>
          <input type="radio" checked={mode === "note"} onChange={() => setMode("note")} /> Internal note
        </label>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} aria-label={mode === "reply" ? "Reply" : "Note"} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {mode === "reply" ? (
          <label>
            Then set status{" "}
            <select value={after} onChange={(e) => setAfter(e.target.value as TicketStatus)}>
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="submit" disabled={send.isPending || !text.trim()}>
          {send.isPending ? "Sending…" : mode === "reply" ? "Send reply" : "Add note"}
        </button>
      </div>
      {send.error ? <p role="alert">{send.error.message}</p> : null}
    </form>
  );
}
