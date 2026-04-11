// Shared helpers for MCP tool handlers.

import { AuthenticationRequiredError } from "../errors.js";
import type { GraphClient } from "../graph/client.js";
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

/**
 * Return the shared GraphClient from ServerConfig.
 *
 * The client holds a TokenCredential (the Authenticator) and fetches a fresh
 * (or silently-refreshed) token on every request — correct for long-running
 * MCP server instances.  If the token cannot be refreshed, GraphClient will
 * throw AuthenticationRequiredError, which formatError maps to the standard
 * "please use the login tool" message.
 */
export function createAuthenticatedClient(
  config: ServerConfig,
): Promise<GraphClient> {
  return Promise.resolve(config.graphClient);
}
