import type { AgentRole, Mailbox } from "@rolandihms/helpdesk-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { agentsQuery, errorText, helpdesk, mailboxesQuery, meQuery } from "../api";

export function Settings() {
  const me = useQuery(meQuery);
  if (me.data && me.data.role !== "admin") {
    return (
      <main className="content narrow">
        <p className="alert">Only admins can change settings.</p>
      </main>
    );
  }
  return (
    <main className="content narrow settings">
      <h1>Settings</h1>
      <Agents myId={me.data?.agent?.id} />
      <Mailboxes />
    </main>
  );
}

/** Reads a submitted form as plain strings, then resets it on success. */
function formValues(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  const form = e.currentTarget;
  return { form, get: (name: string) => String(new FormData(form).get(name) ?? "").trim() };
}

function Agents({ myId }: { myId: string | undefined }) {
  const qc = useQueryClient();
  const agents = useQuery(agentsQuery);
  const done = () => qc.invalidateQueries({ queryKey: agentsQuery.queryKey });
  const create = useMutation({ mutationFn: helpdesk.agents.create, onSuccess: done });
  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; role?: AgentRole; active?: boolean }) => helpdesk.agents.update(id, patch),
    onSettled: done,
  });

  return (
    <section className="card">
      <h2>Agents</h2>
      <p className="muted">
        People who can sign in. Each one also needs to be allowed by the Cloudflare Access policy for this site.
      </p>
      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {agents.data?.map((a) => (
            <tr key={a.id} className={a.active ? undefined : "inactive"}>
              <td>{a.name}</td>
              <td>{a.email}</td>
              <td>
                <select
                  value={a.role}
                  disabled={a.id === myId || update.isPending}
                  aria-label={`Role of ${a.name}`}
                  onChange={(e) => update.mutate({ id: a.id, role: e.target.value as AgentRole })}
                >
                  <option value="agent">Agent</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td>
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={a.id === myId || update.isPending}
                  onClick={() => update.mutate({ id: a.id, active: !a.active })}
                >
                  {a.active ? "Deactivate" : "Reactivate"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {update.error ? <p className="alert">{errorText(update.error)}</p> : null}

      <form
        className="row-form"
        onSubmit={(e) => {
          const { form, get } = formValues(e);
          create.mutate({ email: get("email"), name: get("name"), role: get("role") as AgentRole }, { onSuccess: () => form.reset() });
        }}
      >
        <input name="name" placeholder="Name" required maxLength={255} aria-label="Name" />
        <input name="email" type="email" placeholder="Email" required aria-label="Email" />
        <select name="role" defaultValue="agent" aria-label="Role">
          <option value="agent">Agent</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" className="btn primary" disabled={create.isPending}>
          Add agent
        </button>
      </form>
      {create.error ? <p className="alert">{errorText(create.error)}</p> : null}
    </section>
  );
}

function Mailboxes() {
  const qc = useQueryClient();
  const mailboxes = useQuery(mailboxesQuery);
  const create = useMutation({ mutationFn: helpdesk.mailboxes.create, onSuccess: () => qc.invalidateQueries({ queryKey: mailboxesQuery.queryKey }) });
  const [prefix, setPrefix] = useState("");

  return (
    <section className="card">
      <h2>Mailboxes</h2>
      <p className="muted">
        Addresses that receive mail. Each one also needs an Email Routing rule that sends it to this Worker. "Notify" lists
        staff addresses that get a copy of every new ticket.
      </p>
      <table className="grid">
        <thead>
          <tr>
            <th>Address</th>
            <th>Name</th>
            <th>Sender name</th>
            <th>Ref prefix</th>
            <th>Notify</th>
          </tr>
        </thead>
        <tbody>
          {mailboxes.data?.map((m) => (
            <tr key={m.id}>
              <td>{m.address}</td>
              <td>{m.name}</td>
              <td>{m.fromName ?? <span className="muted">—</span>}</td>
              <td>
                <code>{m.refPrefix}</code>
              </td>
              <td>
                <NotifyList mailbox={m} />
              </td>
            </tr>
          ))}
          {mailboxes.data?.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                No mailboxes yet. Add one to start receiving mail.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <form
        className="row-form"
        onSubmit={(e) => {
          const { form, get } = formValues(e);
          create.mutate(
            { address: get("address"), name: get("name"), refPrefix: get("refPrefix"), ...(get("fromName") ? { fromName: get("fromName") } : {}) },
            {
              onSuccess: () => {
                form.reset();
                setPrefix("");
              },
            },
          );
        }}
      >
        <input name="address" type="email" placeholder="support@help.example.com" required aria-label="Address" />
        <input name="name" placeholder="Name" required maxLength={255} aria-label="Name" />
        <input name="fromName" placeholder="Sender name (optional)" maxLength={255} aria-label="Sender name" />
        <input
          name="refPrefix"
          placeholder="SUP"
          required
          pattern="[A-Z0-9]{2,10}"
          title="2 to 10 letters or digits"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value.toUpperCase())}
          aria-label="Ref prefix"
          className="short"
        />
        <button type="submit" className="btn primary" disabled={create.isPending}>
          Add mailbox
        </button>
      </form>
      {create.error ? <p className="alert">{errorText(create.error)}</p> : null}
    </section>
  );
}

/** The new-ticket notification addresses of one mailbox, edited in place as a comma-separated list. */
function NotifyList({ mailbox }: { mailbox: Mailbox }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: (notifyNewTicket: string[]) => helpdesk.mailboxes.update(mailbox.id, { notifyNewTicket }),
    onSuccess: () => {
      setEditing(false);
      return qc.invalidateQueries({ queryKey: mailboxesQuery.queryKey });
    },
  });

  if (!editing) {
    return (
      <span className="notify-list">
        {mailbox.notifyNewTicket.length ? mailbox.notifyNewTicket.join(", ") : <span className="muted">—</span>}{" "}
        <button type="button" className="btn ghost small" onClick={() => setEditing(true)} aria-label={`Edit notifications for ${mailbox.address}`}>
          Edit
        </button>
      </span>
    );
  }
  return (
    <form
      className="row-form"
      onSubmit={(e) => {
        const { get } = formValues(e);
        save.mutate(get("notify").split(/[\s,;]+/).filter(Boolean));
      }}
    >
      <input
        name="notify"
        defaultValue={mailbox.notifyNewTicket.join(", ")}
        placeholder="ops@example.com, lead@example.com"
        aria-label={`Notification addresses for ${mailbox.address}`}
        autoFocus
      />
      <button type="submit" className="btn primary small" disabled={save.isPending}>
        Save
      </button>
      <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {save.error ? <p className="alert">{errorText(save.error)}</p> : null}
    </form>
  );
}
