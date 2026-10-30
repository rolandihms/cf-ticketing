import type { DbEnv } from "@rolandihms/helpdesk-db";

/**
 * Bindings and vars the help desk reads. Your Worker's Env must provide these (see apps/worker/wrangler.jsonc);
 * it may have more. Optional entries switch features off when absent.
 */
export interface HelpdeskEnv extends DbEnv {
  /** Raw mail, bodies, notes, replies and attachments. */
  MAIL: R2Bucket;
  /** Email Sending (acks and agent replies). */
  EMAIL: SendEmail;
  /** The help desk's Workflow (inbound mail and agent-action events). */
  INBOUND_WORKFLOW: Workflow;
  /** Workers AI, for the default LLM classifier. */
  AI?: Ai;

  /** "send" | "reply" | "off" */
  ACK_MODE?: string;
  /** "raw" | "builder" */
  EMAIL_SEND_FORMAT?: string;
  AUTO_CREATE_MAILBOXES?: string;
  DEFAULT_REF_PREFIX?: string;
  AI_MODEL?: string;
  AI_GATEWAY_ID?: string;

  /** Link to a ticket in your agent UI, for new-ticket notifications; "{ref}" becomes the ticket ref. */
  TICKET_URL?: string;

  /** Table name prefix, e.g. "hd_" (see docs/EMBEDDING.md). `createHelpdesk({ tablePrefix })` overrides it. */
  TABLE_PREFIX?: string;

  // ---- API auth (docs/AGENT-API.md) ----
  /** Secret: `Authorization: Bearer <API_TOKEN>` acts as an admin service. */
  API_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** "on" to accept X-Helpdesk-Principal from a host app (service binding). Needs HELPDESK_SERVICE_KEY. */
  TRUSTED_PRINCIPAL?: string;
  /** Secret shared with the host app for trusted-principal requests. */
  HELPDESK_SERVICE_KEY?: string;

  // ---- optional integrations ----
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
}
