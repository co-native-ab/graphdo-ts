// MCP tools for OneDrive-backed markdown file management.
//
// This file is the public re-export surface. The implementation is split
// across cohesive sibling modules:
//
//   - `markdown-defs.ts`     static {@link ToolDef} entries + `MARKDOWN_TOOL_DEFS`
//   - `markdown-helpers.ts`  schemas, drive-item resolver, formatters,
//                            best-effort `webUrl` lookup
//   - `markdown-register.ts` `registerMarkdownTools` (handler bodies)
//
// All callers continue to import from `./markdown.js` — the split is
// internal-only.

export { MARKDOWN_TOOL_DEFS } from "./markdown-defs.js";
export { registerMarkdownTools } from "./markdown-register.js";
