import type { HelpdeskEnv } from "../env";
import type { HelpdeskPlugin } from "@cf-helpdesk/core";

/** Example plugin: logs ticket activity. Copy it as a starting point for your own. */
export const loggerPlugin: HelpdeskPlugin<HelpdeskEnv> = {
  name: "logger",
  async onTicketCreated(ctx) {
    await ctx.step.do("log", async () => {
      ctx.log("ticket created", { ref: ctx.ticket.ref, from: ctx.message.from.address, subject: ctx.ticket.subject });
    });
  },
  async onMessageReceived(ctx) {
    await ctx.step.do("log", async () => {
      ctx.log("message added", { ref: ctx.ticket.ref, from: ctx.message.from.address });
    });
  },
};
