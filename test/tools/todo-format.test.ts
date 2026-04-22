// Unit tests for todo formatting helpers.

import { describe, it, expect } from "vitest";

import {
  statusEmoji,
  statusLabel,
  importanceLabel,
  formatDate,
  formatRecurrence,
} from "../../src/tools/todo/helpers/format.js";
import type { PatternedRecurrence } from "../../src/graph/types.js";

describe("statusEmoji", () => {
  it("returns ✅ for completed", () => {
    expect(statusEmoji("completed")).toBe("✅");
  });

  it("returns ⬜ for notStarted", () => {
    expect(statusEmoji("notStarted")).toBe("⬜");
  });

  it("returns 🔵 for inProgress", () => {
    expect(statusEmoji("inProgress")).toBe("🔵");
  });

  it("returns ⏳ for waitingOnOthers", () => {
    expect(statusEmoji("waitingOnOthers")).toBe("⏳");
  });

  it("returns ⏸️ for deferred", () => {
    expect(statusEmoji("deferred")).toBe("⏸️");
  });
});

describe("statusLabel", () => {
  it("returns Completed for completed", () => {
    expect(statusLabel("completed")).toBe("Completed");
  });

  it("returns Not Started for notStarted", () => {
    expect(statusLabel("notStarted")).toBe("Not Started");
  });

  it("returns In Progress for inProgress", () => {
    expect(statusLabel("inProgress")).toBe("In Progress");
  });

  it("returns Waiting on Others for waitingOnOthers", () => {
    expect(statusLabel("waitingOnOthers")).toBe("Waiting on Others");
  });

  it("returns Deferred for deferred", () => {
    expect(statusLabel("deferred")).toBe("Deferred");
  });
});

describe("importanceLabel", () => {
  it("returns empty string for normal", () => {
    expect(importanceLabel("normal")).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(importanceLabel(undefined)).toBe("");
  });

  it("returns ❗ for high", () => {
    expect(importanceLabel("high")).toBe(" ❗");
  });

  it("returns ↓ for low", () => {
    expect(importanceLabel("low")).toBe(" ↓");
  });
});

describe("formatDate", () => {
  it("returns empty string for undefined", () => {
    expect(formatDate(undefined)).toBe("");
  });

  it("formats a date/time with timezone", () => {
    expect(formatDate({ dateTime: "2025-01-15T09:00:00", timeZone: "UTC" })).toBe(
      "2025-01-15T09:00:00 (UTC)",
    );
  });
});

describe("formatRecurrence", () => {
  it("returns empty string for undefined", () => {
    expect(formatRecurrence(undefined)).toBe("");
  });

  it("formats daily recurrence with interval 1", () => {
    const rec: PatternedRecurrence = {
      pattern: { type: "daily", interval: 1 },
      range: { type: "noEnd", startDate: "2025-01-01" },
    };
    expect(formatRecurrence(rec)).toBe("day(s)");
  });

  it("formats daily recurrence with interval > 1", () => {
    const rec: PatternedRecurrence = {
      pattern: { type: "daily", interval: 3 },
      range: { type: "noEnd", startDate: "2025-01-01" },
    };
    expect(formatRecurrence(rec)).toBe("every 3 day(s)");
  });

  it("formats weekly recurrence with days", () => {
    const rec: PatternedRecurrence = {
      pattern: {
        type: "weekly",
        interval: 1,
        daysOfWeek: ["monday", "wednesday"],
        firstDayOfWeek: "sunday",
      },
      range: { type: "noEnd", startDate: "2025-01-01" },
    };
    expect(formatRecurrence(rec)).toBe("week(s) on monday, wednesday");
  });

  it("formats absoluteMonthly recurrence", () => {
    const rec: PatternedRecurrence = {
      pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: 15 },
      range: { type: "noEnd", startDate: "2025-01-01" },
    };
    expect(formatRecurrence(rec)).toBe("month(s) on day 15");
  });

  it("formats absoluteMonthly with interval > 1", () => {
    const rec: PatternedRecurrence = {
      pattern: { type: "absoluteMonthly", interval: 2, dayOfMonth: 1 },
      range: { type: "noEnd", startDate: "2025-01-01" },
    };
    expect(formatRecurrence(rec)).toBe("every 2 month(s) on day 1");
  });

  it("formats relativeMonthly recurrence", () => {
    const rec: PatternedRecurrence = {
      pattern: {
        type: "relativeMonthly",
        interval: 1,
        daysOfWeek: ["monday"],
        index: "first",
      },
      range: { type: "noEnd", startDate: "2025-01-01" },
    };
    expect(formatRecurrence(rec)).toBe("month(s) on monday");
  });

  it("formats absoluteYearly recurrence", () => {
    const rec: PatternedRecurrence = {
      pattern: { type: "absoluteYearly", interval: 1, dayOfMonth: 15, month: 1 },
      range: { type: "noEnd", startDate: "2025-01-01" },
    };
    expect(formatRecurrence(rec)).toBe("year(s)");
  });

  it("formats relativeYearly recurrence", () => {
    const rec: PatternedRecurrence = {
      pattern: {
        type: "relativeYearly",
        interval: 1,
        daysOfWeek: ["monday"],
        index: "first",
        month: 1,
      },
      range: { type: "noEnd", startDate: "2025-01-01" },
    };
    expect(formatRecurrence(rec)).toBe("year(s)");
  });
});
