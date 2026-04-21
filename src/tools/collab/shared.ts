// Shared helpers for the collab MCP tool family.
//
// This file is the public re-export surface. The implementation is split
// across cohesive sibling modules:
//
//   - `shared-defs.ts`    constants + static {@link ToolDef} entries
//   - `shared-errors.ts`  cross-tool errors (session/file/path/refusals)
//   - `shared-helpers.ts` audit mappers, session+scope plumbing, formatters,
//                         path/MIME helpers, target resolution
//
// All callers continue to import from `./shared.js` — the split is
// internal-only.

export * from "./shared-defs.js";
export * from "./shared-errors.js";
export * from "./shared-helpers.js";
