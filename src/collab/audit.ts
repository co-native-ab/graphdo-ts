// Audit JSONL writer for collab v1 (`docs/plans/collab-v1.md` §3.6).
//
// This file is the public re-export surface. The implementation is split
// across cohesive sibling modules:
//
//   - `audit-types.ts`   constants, enums, envelope types, path helpers
//   - `audit-builder.ts` envelope shaping, redaction, line builder, errors
//   - `audit-writer.ts`  best-effort JSONL appender (`writeAudit`)
//   - `audit-reader.ts`  partial-line tolerant parser / file reader
//
// All callers continue to import from `./audit.js` — the split is
// internal-only.

export * from "./audit-types.js";
export * from "./audit-builder.js";
export * from "./audit-writer.js";
export * from "./audit-reader.js";
