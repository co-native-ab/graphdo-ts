// MCP tools for the collab v1 file/section operations: read, list, write,
// section leases, proposals (`docs/plans/collab-v1.md` §2.3).
//
// W4 buffer (W6 reserve day 1) refactor: the previous monolithic
// `src/tools/collab.ts` was split into per-tool modules under this
// directory. Pure code-organisation; no behaviour change, no public-API
// churn — this module is the entry point and re-exports the same
// {@link COLLAB_TOOL_DEFS} manifest and {@link registerCollabTools}
// function the rest of the codebase imports.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";

import { registerCollabRead } from "./read.js";
import { registerCollabListFiles } from "./list-files.js";
import { registerCollabWrite } from "./write.js";
import { registerCollabApplyProposal, registerCollabCreateProposal } from "./proposal.js";
import { registerCollabAcquireSection, registerCollabReleaseSection } from "./leases.js";

export { COLLAB_TOOL_DEFS } from "./shared.js";

/**
 * Register collab tools on the given MCP server.
 *
 * The order of registration is preserved from the pre-refactor
 * monolithic module so the tool-list snapshots in
 * `test/integration/login.test.ts` and
 * `test/integration/dynamic-tools.test.ts` continue to match.
 */
export function registerCollabTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  return [
    registerCollabRead(server, config),
    registerCollabListFiles(server, config),
    registerCollabWrite(server, config),
    registerCollabCreateProposal(server, config),
    registerCollabApplyProposal(server, config),
    registerCollabAcquireSection(server, config),
    registerCollabReleaseSection(server, config),
  ];
}
