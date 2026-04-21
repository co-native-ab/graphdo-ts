// Shared helpers for MCP tool handlers.

import { AuthenticationRequiredError } from "../errors.js";
import { logger } from "../logger.js";

/**
 * Format a caught error into a standard MCP tool error result.
 *
 * Handles AuthenticationRequiredError (returns its message directly),
 * GraphRequestError (message already includes method/path/status), and
 * generic Error / unknown values.
 *
 * An optional `prefix` is prepended and `suffix` appended to the message
 * for tool-specific context (e.g. "Login failed: …").  Neither is applied
 * when the error is an AuthenticationRequiredError — that message is
 * returned as-is.
 */
export function formatError(
  toolName: string,
  err: unknown,
  options?: { prefix?: string; suffix?: string },
): { content: { type: "text"; text: string }[]; isError: true } {
  if (err instanceof AuthenticationRequiredError) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`${toolName} failed`, { error: message });
  const text = `${options?.prefix ?? ""}${message}${options?.suffix ?? ""}`;
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Retry-hint suffix shared by every browser-picker-backed tool
 * (`todo_select_list`, `markdown_select_root_folder`). When the
 * underlying picker times out the user gets a friendlier phrasing
 * than the generic retry hint. Centralised so wording stays uniform.
 */
export function retryHintForPickerError(err: unknown): string {
  const isTimeout = err instanceof Error && err.message.toLowerCase().includes("timed out");
  return isTimeout
    ? "\n\nThe user did not make a selection in time. " +
        "You can call this tool again if the user would like to retry."
    : "\n\nYou can call this tool again if the user would like to retry.";
}
