import type { InboundMessageMeta, Mailbox, Ticket } from "@cf-helpdesk/core";
import { subjectWithRef } from "@cf-helpdesk/core";

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
