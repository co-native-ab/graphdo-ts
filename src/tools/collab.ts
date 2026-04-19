// MCP tools for the collab v1 file/section operations: read, list, write,
// section leases, proposals, etc. (`docs/plans/collab-v1.md` §2.3).
//
// Empty registration in W1 Day 3 — the module skeleton ships now so that
// `src/index.ts` already wires it up, but no tools are registered yet.
// `collab_read` / `collab_list_files` land in W2 Day 4; `collab_write` in
// W3 Day 2; and so on through Week 4.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "../index.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";

/** Static tool metadata for collab tools — empty until W2 Day 4. */
export const COLLAB_TOOL_DEFS: readonly ToolDef[] = [];

/**
 * Register collab `*` tools on the given MCP server. Returns an empty
 * array in W1 Day 3 so callers can already wire this into the tool
 * registry without an extra conditional.
 */
export function registerCollabTools(_server: McpServer, _config: ServerConfig): ToolEntry[] {
  return [];
}
