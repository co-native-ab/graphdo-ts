import { describe, it, expect } from "vitest";

import {
  MAX_GRAPH_ID_LENGTH,
  tryValidateGraphId,
  unsafeAssumeValidatedGraphId,
  validateGraphId,
  type ValidatedGraphId,
} from "../../src/graph/ids.js";

describe("validateGraphId", () => {
  it("accepts realistic Graph IDs", () => {
    expect(() => validateGraphId("itemId", "01ABCDEFGHIJKLMN")).not.toThrow();
    expect(() => validateGraphId("versionId", "1.0")).not.toThrow();
    expect(() => validateGraphId("folderId", "folder-1")).not.toThrow();
    expect(() => validateGraphId("listId", "list-1")).not.toThrow();
    expect(() => validateGraphId("taskId", "AAMkAD...AABg=")).not.toThrow();
  });

  it("rejects non-string inputs", () => {
    expect(() => validateGraphId("itemId", undefined)).toThrow("itemId must be a string");
    expect(() => validateGraphId("itemId", null)).toThrow("itemId must be a string");
    expect(() => validateGraphId("itemId", 42)).toThrow("itemId must be a string");
    expect(() => validateGraphId("itemId", {})).toThrow("itemId must be a string");
  });

  it("rejects empty strings", () => {
    expect(() => validateGraphId("itemId", "")).toThrow("itemId must not be empty");
  });

  it("rejects path separators", () => {
    expect(() => validateGraphId("itemId", "a/b")).toThrow("path separators");
    expect(() => validateGraphId("itemId", "a\\b")).toThrow("path separators");
  });

  it("rejects whitespace and control characters", () => {
    expect(() => validateGraphId("itemId", "a b")).toThrow("whitespace");
    expect(() => validateGraphId("itemId", "a\tb")).toThrow("whitespace");
    expect(() => validateGraphId("itemId", "a\nb")).toThrow("whitespace");
    expect(() => validateGraphId("itemId", "a\x00b")).toThrow("control characters");
    expect(() => validateGraphId("itemId", "a\x7fb")).toThrow("control characters");
  });

  it("rejects non-ASCII", () => {
    expect(() => validateGraphId("itemId", "café")).toThrow("ASCII");
  });

  it(`rejects values longer than ${String(MAX_GRAPH_ID_LENGTH)} chars`, () => {
    expect(() => validateGraphId("itemId", "a".repeat(MAX_GRAPH_ID_LENGTH + 1))).toThrow(
      `longer than ${String(MAX_GRAPH_ID_LENGTH)}`,
    );
    // Boundary: exactly MAX_GRAPH_ID_LENGTH is accepted.
    expect(() => validateGraphId("itemId", "a".repeat(MAX_GRAPH_ID_LENGTH))).not.toThrow();
  });

  it("returns a value that string operations preserve", () => {
    const id: ValidatedGraphId = validateGraphId("itemId", "abc-123");
    expect(typeof id).toBe("string");
    expect(id.length).toBe(7);
    expect(`${id}/x`).toBe("abc-123/x");
    expect(encodeURIComponent(id)).toBe("abc-123");
  });
});

describe("tryValidateGraphId", () => {
  it("returns ok with the branded value on success", () => {
    const result = tryValidateGraphId("itemId", "abc");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("abc");
    }
  });

  it("returns a structured failure for each rule", () => {
    expect(tryValidateGraphId("itemId", "")).toEqual({
      ok: false,
      reason: "itemId must not be empty",
    });
    expect(tryValidateGraphId("itemId", "a/b")).toEqual({
      ok: false,
      reason: "itemId must not contain path separators (/ or \\)",
    });
    expect(tryValidateGraphId("itemId", 42)).toEqual({
      ok: false,
      reason: "itemId must be a string",
    });
  });
});

describe("unsafeAssumeValidatedGraphId", () => {
  it("returns its input as a ValidatedGraphId", () => {
    // Intentionally bypasses validation — the function exists for
    // values we've already proven safe by other means (e.g. a
    // Zod-parsed Graph response field). At runtime the brand is
    // erased so the output equals the input.
    const id = unsafeAssumeValidatedGraphId("known-good-id");
    expect(id).toBe("known-good-id");
  });
});
