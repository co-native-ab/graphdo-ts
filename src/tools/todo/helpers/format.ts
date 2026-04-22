// Formatting helpers for To Do tool output.

import type {
  DateTimeTimeZone,
  PatternedRecurrence,
  TodoStatus,
  Importance,
} from "../../../graph/types.js";

export function statusEmoji(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "✅";
    case "inProgress":
      return "🔵";
    case "waitingOnOthers":
      return "⏳";
    case "deferred":
      return "⏸️";
    case "notStarted":
      return "⬜";
  }
}

export function statusLabel(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "inProgress":
      return "In Progress";
    case "waitingOnOthers":
      return "Waiting on Others";
    case "deferred":
      return "Deferred";
    case "notStarted":
      return "Not Started";
  }
}

export function importanceLabel(importance?: Importance): string {
  if (!importance || importance === "normal") return "";
  return importance === "high" ? " ❗" : " ↓";
}

export function formatDate(dt?: DateTimeTimeZone): string {
  if (!dt) return "";
  return `${dt.dateTime} (${dt.timeZone})`;
}

export function formatRecurrence(rec?: PatternedRecurrence): string {
  if (!rec) return "";
  const p = rec.pattern;
  const interval = p.interval > 1 ? `every ${String(p.interval)} ` : "";
  switch (p.type) {
    case "daily":
      return `${interval}day(s)`;
    case "weekly":
      return `${interval}week(s)${p.daysOfWeek ? ` on ${p.daysOfWeek.join(", ")}` : ""}`;
    case "absoluteMonthly":
      return `${interval}month(s) on day ${String(p.dayOfMonth ?? "")}`;
    case "relativeMonthly":
      return `${interval}month(s)${p.daysOfWeek ? ` on ${p.daysOfWeek.join(", ")}` : ""}`;
    case "absoluteYearly":
      return `${interval}year(s)`;
    case "relativeYearly":
      return `${interval}year(s)`;
    default:
      return p.type;
  }
}
