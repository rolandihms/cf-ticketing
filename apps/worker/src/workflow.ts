import { normalizeMessageId, type GuardResult } from "@cf-helpdesk/core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import config from "../helpdesk.config";
import { createRepo } from "./db/repo";
import { newMessageId, sendViaBinding, type SendFormat } from "./email/outbound";
import { parseAndStore, type StoredRawRef } from "./email/parse";
import { ackTemplate } from "./email/templates";
import { ingestInbound } from "./ingest";
import { runPlugins } from "./plugins/runner";

export interface InboundParams extends StoredRawRef {
  guard: GuardResult;
  /** "workflow": this Workflow sends the ack. "handled": already acked in the email handler (ACK_MODE=reply). "none": no ack. */
  ack: "workflow" | "handled" | "none";
}

export interface InboundOutput {
  ticketRef: string;
  ticketId: string;
  created: boolean;
  threadedBy: string;
  acked: boolean;
}

export class InboundEmailWorkflow extends WorkflowEntrypoint<Env, InboundParams> {
  async run(event: WorkflowEvent<InboundParams>, step: WorkflowStep): Promise<InboundOutput> {
    const p = event.payload;
    const repo = createRepo(this.env);

    const meta = await step.do("parse", () => parseAndStore(this.env.MAIL, p));

    const persisted = await step.do("persist", async () => {
      const mailbox = await repo.getMailboxByAddress(p.mailboxAddress);
      if (!mailbox) throw new Error(`mailbox ${p.mailboxAddress} not found`);
      const r = await ingestInbound(repo, mailbox, meta, p.guard);
      return { mailbox, ticket: r.ticket, created: r.created, messageId: r.messageId, threadedBy: r.threadedBy };
    });
    const { mailbox, ticket } = persisted;

    let acked = false;
    const shouldAck = p.ack === "workflow" && persisted.created && p.guard.allowAutoReply && config.ackNewTickets !== false;
    if (shouldAck) {
      const sent = await step.do(
        "ack:send",
        { retries: { limit: 6, delay: "1 minute", backoff: "exponential" }, timeout: "2 minutes" },
        async () => {
          const tpl = ackTemplate(mailbox, ticket, meta);
          const messageId = newMessageId(mailbox.address.split("@")[1]!);
          const res = await sendViaBinding(
            this.env.EMAIL,
            {
              from: { email: mailbox.address, name: mailbox.fromName ?? mailbox.name },
              to: { email: meta.from.address, name: meta.from.name },
              subject: tpl.subject,
              text: tpl.text,
              html: tpl.html,
              messageId,
              inReplyTo: meta.messageId,
              references: meta.references.slice().reverse(),
              ticketRef: ticket.ref,
              autoSubmitted: true,
            },
            (this.env.EMAIL_SEND_FORMAT as SendFormat) || "raw",
          );
          const providerMessageId = res.providerMessageId ? normalizeMessageId(res.providerMessageId) ?? res.providerMessageId : null;
          return { messageId, providerMessageId, subject: tpl.subject, text: tpl.text };
        },
      );
      // Separate step so a DB hiccup here never re-sends the email (step results are cached).
      await step.do("ack:record", async () => {
        await repo.appendMessage({
          ticket,
          reopen: false,
          actor: "system:ack",
          attachments: [],
          message: {
            direction: "outbound",
            kind: "ack",
            ingest_key: null,
            message_id_hdr: sent.messageId,
            provider_msg_id: sent.providerMessageId,
            in_reply_to: meta.messageId,
            from_addr: mailbox.address,
            to_json: JSON.stringify([meta.from.address]),
            cc_json: null,
            subject: sent.subject,
            text_preview: sent.text.slice(0, 500),
            text_r2_key: null,
            html_r2_key: null,
            raw_r2_key: null,
            auth_json: null,
            author_agent_id: null,
          },
        });
      });
      acked = true;
    }

    await runPlugins(
      config,
      step,
      { event: persisted.created ? "ticket.created" : "message.received", ticket, mailbox, message: meta, env: this.env },
      (plugin, error) => repo.addEvent(ticket.id, "plugin.failed", `plugin:${plugin}`, { error }),
    );

    return { ticketRef: ticket.ref, ticketId: ticket.id, created: persisted.created, threadedBy: persisted.threadedBy, acked: acked || p.ack === "handled" };
  }
}
