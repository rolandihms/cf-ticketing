import type { Kysely } from "kysely";
import type { SqlDialect } from "../types";
import { columnTypes } from "./column-types";

/**
 * Requesters: customers who use the host app (docs/EMBEDDING.md §7).
 * - contacts.external_id: the host app's user id for a contact, so a changed email address keeps the contact.
 * - tickets.metadata_json: string → string pairs the host attaches (e.g. a site or unit id).
 * - tickets.requester_verified: 1 when the requester is proven (portal/app, or email with dmarc=pass), 0 when
 *   not; null for tickets from before this migration. Requesters only ever see tickets with 1.
 * - messages.author_contact_id: who posted a requester message (a company member may write on a colleague's ticket).
 */
export function up(db: Kysely<unknown>, d: SqlDialect) {
  const t = columnTypes(d);
  const s = db.schema;
  return [
    s.alterTable("contacts").addColumn("external_id", t.str(128)),
    s.createIndex("contacts_external_id_uq").on("contacts").column("external_id").unique(),
    s.alterTable("tickets").addColumn("metadata_json", t.json),
    s.alterTable("tickets").addColumn("requester_verified", t.bool),
    s.alterTable("messages").addColumn("author_contact_id", t.id),
  ];
}
