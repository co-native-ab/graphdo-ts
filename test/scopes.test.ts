// Unit tests for GraphScope enum, scope definitions, and helpers.

import { describe, it, expect } from "vitest";
import {
  GraphScope,
  AVAILABLE_SCOPES,
  ALWAYS_REQUIRED_SCOPES,
  defaultScopes,
  isGraphScope,
  toGraphScopes,
} from "../src/scopes.js";

describe("GraphScope enum", () => {
  it("has expected values matching Microsoft identifiers", () => {
    expect(GraphScope.MailSend).toBe("Mail.Send");
    expect(GraphScope.TasksReadWrite).toBe("Tasks.ReadWrite");
    expect(GraphScope.FilesReadWrite).toBe("Files.ReadWrite");
    expect(GraphScope.UserRead).toBe("User.Read");
    expect(GraphScope.OfflineAccess).toBe("offline_access");
  });
});

describe("AVAILABLE_SCOPES", () => {
  it("contains all GraphScope enum values", () => {
    const scopeValues = AVAILABLE_SCOPES.map((s) => s.scope);
    for (const val of Object.values(GraphScope)) {
      expect(scopeValues).toContain(val);
    }
  });

  it("every definition has label and description", () => {
    for (const def of AVAILABLE_SCOPES) {
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });

  it("marks User.Read and offline_access as required", () => {
    const requiredScopes = AVAILABLE_SCOPES.filter((s) => s.required).map((s) => s.scope);
    expect(requiredScopes).toContain(GraphScope.UserRead);
    expect(requiredScopes).toContain(GraphScope.OfflineAccess);
  });

  it("marks optional scopes as not required", () => {
    const optional = AVAILABLE_SCOPES.filter((s) => !s.required).map((s) => s.scope);
    expect(optional).toContain(GraphScope.MailSend);
    expect(optional).toContain(GraphScope.TasksReadWrite);
    expect(optional).toContain(GraphScope.FilesReadWrite);
  });
});

describe("ALWAYS_REQUIRED_SCOPES", () => {
  it("contains User.Read and offline_access", () => {
    expect(ALWAYS_REQUIRED_SCOPES).toContain(GraphScope.UserRead);
    expect(ALWAYS_REQUIRED_SCOPES).toContain(GraphScope.OfflineAccess);
  });

  it("does not contain optional scopes", () => {
    expect(ALWAYS_REQUIRED_SCOPES).not.toContain(GraphScope.MailSend);
    expect(ALWAYS_REQUIRED_SCOPES).not.toContain(GraphScope.TasksReadWrite);
    expect(ALWAYS_REQUIRED_SCOPES).not.toContain(GraphScope.FilesReadWrite);
  });
});

describe("defaultScopes", () => {
  it("returns all scopes", () => {
    const result = defaultScopes();
    for (const val of Object.values(GraphScope)) {
      expect(result).toContain(val);
    }
  });

  it("returns a new array each time", () => {
    const a = defaultScopes();
    const b = defaultScopes();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("isGraphScope", () => {
  it("returns true for valid scope strings", () => {
    expect(isGraphScope("Mail.Send")).toBe(true);
    expect(isGraphScope("Tasks.ReadWrite")).toBe(true);
    expect(isGraphScope("Files.ReadWrite")).toBe(true);
    expect(isGraphScope("User.Read")).toBe(true);
    expect(isGraphScope("offline_access")).toBe(true);
  });

  it("returns false for invalid strings", () => {
    expect(isGraphScope("Mail.Read")).toBe(false);
    expect(isGraphScope("Tasks.Read")).toBe(false);
    expect(isGraphScope("")).toBe(false);
    expect(isGraphScope("user.read")).toBe(false);
    expect(isGraphScope("MAIL.SEND")).toBe(false);
    expect(isGraphScope("random")).toBe(false);
  });
});

describe("toGraphScopes", () => {
  it("filters valid scopes from a mixed array", () => {
    const result = toGraphScopes(["Mail.Send", "invalid", "Tasks.ReadWrite", "", "User.Read"]);
    expect(result).toEqual([GraphScope.MailSend, GraphScope.TasksReadWrite, GraphScope.UserRead]);
  });

  it("returns empty array for all invalid values", () => {
    expect(toGraphScopes(["nope", "also-nope"])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(toGraphScopes([])).toEqual([]);
  });

  it("preserves all valid scopes", () => {
    const all = Object.values(GraphScope);
    expect(toGraphScopes(all)).toEqual(all);
  });
});
