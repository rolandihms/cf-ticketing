import { createHelpdeskClient, HelpdeskApiError } from "@rolandihms/helpdesk-client";

/** Same origin as the UI: Cloudflare Access's cookie signs every request in. */
export const helpdesk = createHelpdeskClient({ baseUrl: "/api" });

export const meQuery = { queryKey: ["me"], queryFn: helpdesk.me, retry: false, staleTime: 5 * 60_000 } as const;
export const agentsQuery = { queryKey: ["agents"], queryFn: helpdesk.agents.list, staleTime: 60_000 } as const;
export const mailboxesQuery = { queryKey: ["mailboxes"], queryFn: helpdesk.mailboxes.list, staleTime: 60_000 } as const;

export function errorText(err: unknown): string {
  if (err instanceof HelpdeskApiError) {
    if (err.status === 409) return "Someone else changed this at the same time. It has been reloaded; try again.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Infinity],
];

/** "3 hours ago" */
export function ago(ms: number): string {
  let v = (ms - Date.now()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return "";
}

export const fullDate = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
