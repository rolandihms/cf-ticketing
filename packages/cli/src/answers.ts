import { TABLE_PREFIX_RE } from "@rolandihms/helpdesk-db/migrations";

export type DbDriver = "d1" | "postgres" | "mysql" | "planetscale";
export type AckMode = "send" | "reply" | "off";

/** Everything the setup needs to know. Collected from flags and/or prompts. */
export interface Answers {
  accountId: string;
  /** Support address customers write to, e.g. support@acme.com */
  address: string;
  /** Display name used in acknowledgements, e.g. "Acme Support" */
  mailboxName: string;
  /** Ticket reference prefix, e.g. ACME → ACME-000123 */
  refPrefix: string;
  /** Worker name; also prefixes the D1 database, R2 bucket and Workflow. */
  workerName: string;
  /** Local profile; config is written to apps/worker/wrangler.<profile>.jsonc */
  profile: string;
  ackMode: AckMode;
  db: DbDriver;
  /** For postgres/mysql/planetscale. Never written to disk; stored as Hyperdrive config or a secret. */
  databaseUrl?: string;
  /** Prefix for every table, e.g. "hd_", when the database is shared with another application. */
  tablePrefix?: string;
}

export const ADDRESS_RE = /^[a-z0-9._%+-]+@([a-z0-9-]+\.)+[a-z]{2,}$/i;
export const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,53}$/;
export const PREFIX_RE = /^[A-Z0-9]{2,10}$/;

export const domainOf = (address: string) => address.split("@")[1]!.toLowerCase();

/** "support@acme.co.za" → "acme-co-za" */
export const profileFromAddress = (address: string) => domainOf(address).replace(/[^a-z0-9]+/g, "-").slice(0, 40);

/** "support@acme.com" → "ACME" */
export const prefixFromAddress = (address: string) =>
  (domainOf(address).split(".")[0] ?? "TKT").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6) || "TKT";

/** Resource names derived from the worker name, so several help desks can share one account. */
export function resourceNames(a: Pick<Answers, "workerName">) {
  return {
    d1: a.workerName,
    bucket: `${a.workerName}-mail`,
    workflow: `${a.workerName}-inbound`,
    hyperdrive: `${a.workerName}-db`,
  };
}

export function validateAnswers(a: Answers): string[] {
  const errors: string[] = [];
  if (!/^[0-9a-f]{32}$/.test(a.accountId)) errors.push("accountId must be a 32-character Cloudflare account id");
  if (!ADDRESS_RE.test(a.address)) errors.push(`"${a.address}" is not a valid email address`);
  if (!WORKER_NAME_RE.test(a.workerName)) errors.push("worker name: lowercase letters, digits and dashes (max 54)");
  if (!/^[a-z0-9-]{1,40}$/.test(a.profile)) errors.push("profile: lowercase letters, digits and dashes");
  if (!PREFIX_RE.test(a.refPrefix)) errors.push("ref prefix: 2–10 uppercase letters/digits");
  if (a.tablePrefix && !TABLE_PREFIX_RE.test(a.tablePrefix)) errors.push('table prefix: a lowercase letter, then letters, digits or "_" (max 16), e.g. hd_');
  if (!a.mailboxName.trim()) errors.push("mailbox name is required");
  if (a.db !== "d1" && !a.databaseUrl) errors.push(`--database-url is required for --db ${a.db}`);
  if (a.db === "planetscale" && a.databaseUrl && !a.databaseUrl.startsWith("mysql://")) errors.push("PlanetScale URL must start with mysql://");
  return errors;
}
