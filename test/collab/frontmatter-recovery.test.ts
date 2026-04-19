// Read-path doc_id recovery tests (collab v1 §3.1 — W2 Day 2).
//
// Covers the helpers that the future `collab_read` (W2 Day 4) and
// `collab_write` (W3 Day 2) tools layer over the §3.1 codec:
//
//   - `readMarkdownFrontmatter` — splits the envelope and either
//     parses the inner YAML or surfaces a structured "reset" outcome
//     (`reason: "missing" | "malformed"`) with the body preserved.
//   - `resolveDocId` — given a read outcome and the local project
//     metadata's cached `docId`, returns the `doc_id` that the next
//     write must re-inject, or throws `DocIdRecoveryRequiredError`
//     when both the embedded value and the local cache are gone.
//
// Together these are the read-path half of the §3.1 doc_id stability
// contract:
//
//   - frontmatter parseable    → use embedded doc_id
//   - frontmatter reset, cache present → recover from local cache
//   - frontmatter reset, cache absent  → refuse, point at session_recover_doc_id
//
// The matching integration test (`test/integration/04-frontmatter-
// stripped.test.ts`) wires the helpers into the `collab_*` tools when
// those land in W2 Day 4 / W3 Day 2; it lives next to its tools as
// `it.todo` placeholders today.

import { describe, it, expect } from "vitest";

import { COLLAB_FRONTMATTER_VERSION } from "../../src/collab/frontmatter.js";
import { DocIdRecoveryRequiredError } from "../../src/errors.js";
import {
  joinFrontmatter,
  readMarkdownFrontmatter,
  resolveDocId,
  serializeFrontmatter,
  type CollabFrontmatter,
  type FrontmatterResetAudit,
} from "../../src/collab/frontmatter.js";

const SAMPLE_DOC_ID = "01JABCDE0FGHJKMNPQRSTV0WXY";
const RECOVERED_DOC_ID = "01JZZZZZZZZZZZZZZZZZZZZZZZ";

function makeFrontmatter(overrides: Partial<CollabFrontmatter["collab"]> = {}): CollabFrontmatter {
  return {
    collab: {
      version: COLLAB_FRONTMATTER_VERSION,
      doc_id: SAMPLE_DOC_ID,
      created_at: "2026-04-19T05:30:00Z",
      sections: [{ id: "intro", title: "Introduction" }],
      proposals: [],
      authorship: [],
      ...overrides,
    },
  };
}

describe("readMarkdownFrontmatter", () => {
  it("parses a well-formed envelope and returns the embedded body", () => {
    const fm = makeFrontmatter();
    const yaml = serializeFrontmatter(fm);
    const content = joinFrontmatter(yaml, "# Project Foo\n\nBody text.\n");

    const result = readMarkdownFrontmatter(content);

    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.frontmatter.collab.doc_id).toBe(SAMPLE_DOC_ID);
    expect(result.body).toBe("# Project Foo\n\nBody text.\n");
  });

  it("returns reset/missing when the file has no leading envelope", () => {
    const content = "# Body Only\n\nNo frontmatter here.\n";
    const result = readMarkdownFrontmatter(content);

    expect(result.kind).toBe("reset");
    if (result.kind !== "reset") return;
    expect(result.reason).toBe("missing");
    expect(result.body).toBe(content);
    expect(result.parseError).toBeUndefined();
  });

  it("returns reset/missing when the opening delimiter has no closing partner", () => {
    const content = "---\ncollab:\n  version: 1\n# never closes\n";
    const result = readMarkdownFrontmatter(content);

    expect(result.kind).toBe("reset");
    if (result.kind !== "reset") return;
    expect(result.reason).toBe("missing");
  });

  it("normalises CRLF body to LF when reset/missing fires", () => {
    const content = "# CRLF body\r\n\r\nLine two.\r\n";
    const result = readMarkdownFrontmatter(content);

    expect(result.kind).toBe("reset");
    if (result.kind !== "reset") return;
    expect(result.reason).toBe("missing");
    expect(result.body).toBe("# CRLF body\n\nLine two.\n");
  });

  it("returns reset/malformed when the inner YAML fails the strict schema", () => {
    const content = "---\ncollab:\n  version: 99\n  doc_id: x\n---\nbody\n";
    const result = readMarkdownFrontmatter(content);

    expect(result.kind).toBe("reset");
    if (result.kind !== "reset") return;
    expect(result.reason).toBe("malformed");
    expect(result.body).toBe("body\n");
    expect(result.parseError).toBeDefined();
  });

  it("returns reset/malformed when the YAML body uses a forbidden custom tag", () => {
    const content = "---\ncollab: !!str hostile\n---\nrest\n";
    const result = readMarkdownFrontmatter(content);

    expect(result.kind).toBe("reset");
    if (result.kind !== "reset") return;
    expect(result.reason).toBe("malformed");
    expect(result.body).toBe("rest\n");
  });

  it("returns reset/malformed when an unknown sibling key sits next to collab:", () => {
    // Strict-schema rejection at the top level is just as much a "malformed"
    // signal as YAML-level errors; the read-path's response is identical.
    const content =
      '---\ncollab:\n  version: 1\n  doc_id: x\n  created_at: "2026-04-19T05:30:00Z"\nextra: 1\n---\nbody\n';
    const result = readMarkdownFrontmatter(content);

    expect(result.kind).toBe("reset");
    if (result.kind !== "reset") return;
    expect(result.reason).toBe("malformed");
  });

  it("preserves the body verbatim after a CRLF malformed envelope", () => {
    const content = "---\r\ncollab: not_a_mapping\r\n---\r\nLine 1\r\nLine 2\r\n";
    const result = readMarkdownFrontmatter(content);

    expect(result.kind).toBe("reset");
    if (result.kind !== "reset") return;
    expect(result.reason).toBe("malformed");
    expect(result.body).toBe("Line 1\nLine 2\n");
  });
});

describe("resolveDocId", () => {
  const projectId = "01JPROJECT00000000000000XY";

  it("returns the embedded doc_id for a parsed read regardless of the local cache", () => {
    const fm = makeFrontmatter();
    const content = joinFrontmatter(serializeFrontmatter(fm), "body\n");
    const read = readMarkdownFrontmatter(content);

    const fromNullCache = resolveDocId(read, null, projectId);
    expect(fromNullCache).toEqual({ docId: SAMPLE_DOC_ID, source: "frontmatter" });

    // Even if the cache somehow disagrees, frontmatter wins (§3.1):
    // the embedded value is authoritative when present and parseable.
    const fromMismatchedCache = resolveDocId(read, RECOVERED_DOC_ID, projectId);
    expect(fromMismatchedCache).toEqual({ docId: SAMPLE_DOC_ID, source: "frontmatter" });
  });

  it("recovers from the local cache when the read was reset/missing", () => {
    const read = readMarkdownFrontmatter("# body only\n");
    const resolved = resolveDocId(read, RECOVERED_DOC_ID, projectId);
    expect(resolved).toEqual({ docId: RECOVERED_DOC_ID, source: "local-cache" });
  });

  it("recovers from the local cache when the read was reset/malformed", () => {
    const read = readMarkdownFrontmatter("---\ncollab: not_a_mapping\n---\nbody\n");
    const resolved = resolveDocId(read, RECOVERED_DOC_ID, projectId);
    expect(resolved).toEqual({ docId: RECOVERED_DOC_ID, source: "local-cache" });
  });

  it("throws DocIdRecoveryRequiredError when both frontmatter and cache are gone", () => {
    const read = readMarkdownFrontmatter("# body only\n");
    expect(() => resolveDocId(read, null, projectId)).toThrow(DocIdRecoveryRequiredError);
    try {
      resolveDocId(read, null, projectId);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocIdRecoveryRequiredError);
      const e = err as DocIdRecoveryRequiredError;
      expect(e.projectId).toBe(projectId);
      expect(e.nextStep).toBe("session_recover_doc_id");
      expect(e.message).toContain("session_recover_doc_id");
      expect(e.message).toContain(projectId);
    }
  });

  it("FrontmatterResetAudit envelope tracks the recovery outcome shape", () => {
    // This is a typed-shape assertion: the W3 Day 3 audit writer
    // composes the envelope from the read outcome plus the
    // resolveDocId result. The shape is locked by §3.6, so a future
    // change to the interface trips this row.
    const recovered: FrontmatterResetAudit = {
      reason: "missing",
      previousRevision: '"{ABC,17}"',
      recoveredDocId: true,
    };
    const unrecoverable: FrontmatterResetAudit = {
      reason: "malformed",
      previousRevision: null,
      recoveredDocId: false,
    };
    expect(recovered.recoveredDocId).toBe(true);
    expect(unrecoverable.recoveredDocId).toBe(false);
  });
});
