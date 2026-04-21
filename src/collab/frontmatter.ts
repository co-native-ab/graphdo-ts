// Frontmatter codec for the authoritative `.md` file (collab v1 §3.1).
//
// This file is the public re-export surface. The implementation is split
// across cohesive sibling modules:
//
//   - `frontmatter-schema.ts` Zod schemas + types for the `collab:` block
//   - `frontmatter-codec.ts`  parse / serialize / split / join + errors
//   - `frontmatter-doc.ts`    read-with-recovery + `doc_id` resolution
//
// All callers continue to import from `./frontmatter.js` — the split is
// internal-only.

export * from "./frontmatter-schema.js";
export * from "./frontmatter-codec.js";
export * from "./frontmatter-doc.js";
