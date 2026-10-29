import type { TicketPriority, TicketStatus } from "@rolandihms/helpdesk-client";

export const STATUSES: TicketStatus[] = ["new", "open", "pending", "on_hold", "solved", "closed"];
export const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending: "Pending",
  on_hold: "On hold",
  solved: "Solved",
  closed: "Closed",
};

export function StatusPill({ status }: { status: TicketStatus }) {
  return <span className={`pill status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityTag({ priority }: { priority: TicketPriority }) {
  if (priority === "normal") return null;
  return <span className={`tag priority-${priority}`}>{priority}</span>;
}
