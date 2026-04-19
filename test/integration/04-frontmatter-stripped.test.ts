// Integration test #04: frontmatter stripped (collab v1 §10).
//
// **Status: W2 Day 2 — scaffold.**
//
// W2 Day 2 lands the read-path codec helpers (`readMarkdownFrontmatter`,
// `resolveDocId`, `DocIdRecoveryRequiredError`) and their unit tests in
// `test/collab/frontmatter-recovery.test.ts`. The integration scenarios
// described in `docs/plans/collab-v1.md` §8.2 (test 04) drive
// `collab_read` and `collab_write` end-to-end against a mock-Graph file
// whose frontmatter has been wiped — those tools land in W2 Day 4 and
// W3 Day 2 respectively, so the rows below are scaffolded as `it.todo`
// today and lit up alongside their owning milestones.
//
// Per `docs/plans/collab-v1.md` §8.2 row 04 the full DoD covers:
//
//   - Direct mock-Graph write that wipes frontmatter (simulates the
//     OneDrive web "remove formatting" affordance).
//   - Next `collab_read` returns defaults for the `collab` block and
//     echoes the body. A `frontmatter_reset` audit entry is appended
//     with `reason: "missing"`, `recoveredDocId: true` (cache is still
//     populated from the original write), and the file's pre-read
//     `cTag` as `previousRevision`.
//   - Next `collab_write` re-injects the **same `doc_id`** recovered
//     from `<configDir>/projects/<projectId>.json`. The audit entry
//     for that write records the cTag bump but does not duplicate the
//     `frontmatter_reset` (one reset per stripped read).
//   - **Variant: also delete the local project metadata** between the
//     read and the write. The next `collab_write` against the
//     authoritative file refuses with `DocIdRecoveryRequiredError`,
//     pointing the agent at `session_recover_doc_id` (W5 Day 1).
//
// The unit tests in `test/collab/frontmatter-recovery.test.ts` already
// cover the codec-layer half of these flows; integration coverage waits
// on the tools.

import { describe, it } from "vitest";

describe("04-frontmatter-stripped", () => {
  it.todo(
    "after `collab_read` lands (W2 Day 4): reading a frontmatter-stripped authoritative file returns defaults and writes a `frontmatter_reset` audit entry",
  );
  it.todo(
    "after `collab_write` lands (W3 Day 2): the next write re-injects the same `doc_id` recovered from local project metadata",
  );
  it.todo(
    "Variant — local project metadata also wiped: `collab_write` returns `DocIdRecoveryRequiredError` and points the agent at `session_recover_doc_id` (W5 Day 1)",
  );
});
