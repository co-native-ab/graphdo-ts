// MCP tools for managing a collab v1 session lifecycle.
//
// This file is the public re-export surface. The implementation is split
// across cohesive sibling modules:
//
//   - `session-defs.ts`     static {@link ToolDef} entries + `SESSION_TOOL_DEFS`
//   - `session-helpers.ts`  shared internals (path / time / agent-name audit)
//   - `session-init.ts`     `session_init_project` runner
//   - `session-status.ts`   `session_status` runner + leases-cTag lookup
//   - `session-open.ts`     `session_open_project` runner
//   - `session-renew.ts`    `session_renew` runner
//   - `session-recover.ts`  `session_recover_doc_id` runner
//   - `session-register.ts` `registerSessionTools` wiring
//
// All callers continue to import from `./session.js` — the split is
// internal-only.

export { SESSION_TOOL_DEFS } from "./session-defs.js";
export { registerSessionTools } from "./session-register.js";
