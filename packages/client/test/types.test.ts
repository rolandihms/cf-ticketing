import type * as core from "../../core/src/types";
import { expectTypeOf, test } from "vitest";
import type * as client from "../src/types";

// The client declares its own copies of these (it has no dependencies); they must not drift from core.
test("wire types match @rolandihms/helpdesk-core", () => {
  expectTypeOf<client.Ticket>().toEqualTypeOf<core.Ticket>();
  expectTypeOf<client.Agent>().toEqualTypeOf<core.Agent>();
  expectTypeOf<client.Mailbox>().toEqualTypeOf<core.Mailbox>();
  expectTypeOf<client.TicketStatus>().toEqualTypeOf<core.TicketStatus>();
  expectTypeOf<client.TicketPriority>().toEqualTypeOf<core.TicketPriority>();
  expectTypeOf<client.AgentRole>().toEqualTypeOf<core.AgentRole>();
});
