import type { HelpdeskConfig } from "@cf-helpdesk/core";
import type { HelpdeskEnv } from "./env";

/** Everything `createHelpdesk()` accepts: the help desk config (plugins, classification…) plus deployment options. */
export interface HelpdeskOptions<E extends HelpdeskEnv = HelpdeskEnv> extends HelpdeskConfig<E> {
  /**
   * Prefix for every table and index, e.g. "hd_" → hd_tickets. Use it when the help desk shares a
   * database with another application. Overrides the TABLE_PREFIX var. Must match the prefix the
   * migrations were generated with (docs/EMBEDDING.md).
   */
  tablePrefix?: string;
}
