import type { ClassificationOutcome, InboundMessageMeta, Mailbox, Ticket } from "@rolandihms/helpdesk-core";
import { subjectWithRef } from "@rolandihms/helpdesk-core";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function ackTemplate(mailbox: Mailbox, ticket: Ticket, inbound: InboundMessageMeta) {
  const team = mailbox.fromName || mailbox.name;
  const greeting = inbound.from.name ? `Hi ${inbound.from.name},` : "Hi,";
  const subject = subjectWithRef(/^re:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`, ticket.ref);
  const text = [
    greeting,
    "",
    `Thanks for contacting ${team}. We've received your message and opened ticket ${ticket.ref}.`,
    "",
    "Reply to this email to add more information to your ticket. Please keep the ticket number in the subject line.",
    "",
    `— ${team}`,
  ].join("\n");
  const html =
    `<p>${esc(greeting)}</p>` +
    `<p>Thanks for contacting ${esc(team)}. We've received your message and opened ticket <strong>${esc(ticket.ref)}</strong>.</p>` +
    `<p>Reply to this email to add more information to your ticket. Please keep the ticket number in the subject line.</p>` +
    `<p>— ${esc(team)}</p>`;
  return { subject, text, html };
}

/** Longest customer text copied into a staff notification; the rest stays in the help desk. */
export const NOTIFY_BODY_MAX = 20_000;

export interface NewTicketNotice {
  mailbox: Mailbox;
  ticket: Ticket;
  inbound: InboundMessageMeta;
  /** The customer's plain-text body; trimmed to NOTIFY_BODY_MAX here. */
  body: string;
  senderVerified: boolean;
  classification?: ClassificationOutcome;
  /** Link to the ticket in the agent UI, if the deployment has one. */
  ticketUrl?: string;
}

/** Email to staff when a mailbox opens a new ticket. Never sent to the customer. */
export function newTicketTemplate(n: NewTicketNotice) {
  const { mailbox, ticket, inbound, classification: c } = n;
  const subject = subjectWithRef(`New ticket: ${ticket.subject || "(no subject)"}`, ticket.ref);
  const from = inbound.from.name ? `${inbound.from.name} <${inbound.from.address}>` : inbound.from.address;
  const body = n.body.length > NOTIFY_BODY_MAX ? `${n.body.slice(0, NOTIFY_BODY_MAX)}\n\n[… truncated; the full message is in the help desk]` : n.body;
  const facts: [string, string][] = [
    ["Ticket", ticket.ref],
    ["From", n.senderVerified ? from : `${from} (sender not verified: the From address may be forged)`],
    ["To", mailbox.address],
    ["Subject", ticket.subject || "(no subject)"],
    ...(c ? ([["Category", c.category], ["Priority", ticket.priority]] as [string, string][]) : []),
    ...(c?.summary ? ([["Summary", c.summary]] as [string, string][]) : []),
    ...(inbound.attachments.length ? ([["Attachments", String(inbound.attachments.length)]] as [string, string][]) : []),
  ];
  const footer = "This is an automatic notification. Don't reply to it: answer the customer from the help desk.";
  const text = [
    `New ticket ${ticket.ref} in ${mailbox.name}.`,
    "",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    ...(n.ticketUrl ? ["", `Open: ${n.ticketUrl}`] : []),
    "",
    "----- Message -----",
    body,
    "-------------------",
    "",
    footer,
  ].join("\n");
  const html =
    `<p>New ticket <strong>${esc(ticket.ref)}</strong> in ${esc(mailbox.name)}.</p>` +
    `<table>${facts.map(([k, v]) => `<tr><th align="left" valign="top">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>` +
    (n.ticketUrl ? `<p><a href="${esc(n.ticketUrl)}">Open ${esc(ticket.ref)} in the help desk</a></p>` : "") +
    `<hr><pre style="white-space:pre-wrap;font-family:inherit">${esc(body)}</pre><hr>` +
    `<p><small>${esc(footer)}</small></p>`;
  return { subject, text, html };
}

/** TICKET_URL with {ref} filled in; undefined unless it is an http(s) URL. */
export function ticketUrl(template: string | undefined, ref: string): string | undefined {
  if (!template || !/^https?:\/\//i.test(template)) return undefined;
  return template.replaceAll("{ref}", encodeURIComponent(ref));
}
