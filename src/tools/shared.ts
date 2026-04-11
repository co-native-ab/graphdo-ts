// Shared helpers for MCP tool handlers.

import { AuthenticationRequiredError } from "../errors.js";
import { GraphClient } from "../graph/client.js";
import type { ServerConfig } from "../index.js";
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

/** Acquire a token and return a ready-to-use GraphClient. */
export async function createAuthenticatedClient(
  config: ServerConfig,
): Promise<GraphClient> {
  const token = await config.authenticator.token();
  return new GraphClient(config.graphBaseUrl, token);
}
