// Unit tests for src/tools/shared.ts

import { describe, it, expect } from "vitest";

import { AuthenticationRequiredError } from "../../src/errors.js";
import { retryHintForPickerError, formatError } from "../../src/tools/shared.js";

describe("retryHintForPickerError", () => {
  it("returns the timeout-specific hint when the error message includes 'timed out'", () => {
    const hint = retryHintForPickerError(new Error("browser picker timed out after 2 minutes"));
    expect(hint).toContain("did not make a selection in time");
    expect(hint).toContain("retry");
  });

  it("matches 'timed out' case-insensitively", () => {
    const hint = retryHintForPickerError(new Error("TIMED OUT"));
    expect(hint).toContain("did not make a selection in time");
  });

  it("returns the generic retry hint for non-timeout errors", () => {
    const hint = retryHintForPickerError(new Error("save failed"));
    expect(hint).not.toContain("did not make a selection in time");
    expect(hint).toContain("retry");
  });

  it("returns the generic retry hint for non-Error values", () => {
    const hint = retryHintForPickerError("not an error");
    expect(hint).not.toContain("did not make a selection in time");
    expect(hint).toContain("retry");
  });
});

describe("formatError", () => {
  it("returns the AuthenticationRequiredError message verbatim (no prefix/suffix)", () => {
    const err = new AuthenticationRequiredError();
    const result = formatError("tool_x", err, { prefix: "IGNORED: ", suffix: " IGNORED" });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe(err.message);
    expect(result.content[0]?.text).not.toContain("IGNORED");
  });

  it("wraps a generic Error with prefix and suffix", () => {
    const result = formatError("tool_x", new Error("boom"), {
      prefix: "Tool failed: ",
      suffix: " (retry?)",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Tool failed: boom (retry?)");
  });

  it("handles non-Error throwables via String() coercion", () => {
    const result = formatError("tool_x", "plain string error");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("plain string error");
  });

  it("omits prefix/suffix when options are not provided", () => {
    const result = formatError("tool_x", new Error("kaboom"));
    expect(result.content[0]?.text).toBe("kaboom");
  });
});
