// Parsing helpers for To Do tool input (recurrence, dates).

import type { DateTimeTimeZone, PatternedRecurrence, RecurrenceRangeType } from "../graph/types.js";

/**
 * Parse a simplified repeat string into a full PatternedRecurrence.
 * Supports: "daily", "weekly", "weekdays", "monthly", "yearly"
 * with an optional interval (default 1).
 */
export function parseRecurrence(
  repeat: string,
  interval: number,
): PatternedRecurrence {
  const todayParts = new Date().toISOString().split("T");
  const today = todayParts[0] ?? new Date().toISOString().slice(0, 10);
  const range = { type: "noEnd" as RecurrenceRangeType, startDate: today };

  switch (repeat) {
    case "daily":
      return { pattern: { type: "daily", interval }, range };
    case "weekly":
      return {
        pattern: {
          type: "weekly",
          interval,
          daysOfWeek: [currentDayOfWeek()],
          firstDayOfWeek: "sunday",
        },
        range,
      };
    case "weekdays":
      return {
        pattern: {
          type: "weekly",
          interval: 1,
          daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          firstDayOfWeek: "monday",
        },
        range,
      };
    case "monthly":
      return {
        pattern: {
          type: "absoluteMonthly",
          interval,
          dayOfMonth: new Date().getDate(),
        },
        range,
      };
    case "yearly":
      return {
        pattern: {
          type: "absoluteYearly",
          interval,
          dayOfMonth: new Date().getDate(),
          month: new Date().getMonth() + 1,
        },
        range,
      };
    default:
      throw new Error(
        `Unknown repeat value: "${repeat}". Use: daily, weekly, weekdays, monthly, yearly.`,
      );
  }
}

function currentDayOfWeek(): string {
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return days[new Date().getDay()] ?? "monday";
}

/** Parse an ISO date/time string into a DateTimeTimeZone object. */
export function parseDateTimeTimeZone(
  dateStr: string,
  timeZone = "UTC",
): DateTimeTimeZone {
  return { dateTime: dateStr, timeZone };
}
