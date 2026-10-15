import type { Kysely } from "kysely";

/** Customer replies reference the provider-assigned Message-ID (see docs/SPIKES.md); index it. */
export function up(db: Kysely<unknown>) {
  return [db.schema.createIndex("messages_mailbox_provider_idx").on("messages").columns(["mailbox_id", "provider_msg_id"])];
}
