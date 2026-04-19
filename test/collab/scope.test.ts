// Unit tests for the §4.6 pure syntactic validator
// (`validateScopedPathSyntax`).
//
// The full algorithm — including the byId path resolution + post-
// resolution defence-in-depth checks — is exercised end-to-end against
// a mock Graph by `test/integration/08-scope-traversal-rejected.test.ts`.
// These rows cover the steps that **must not** issue any Graph call:
// every refusal here is a contract that callers can rely on for
// zero-cost rejection.

import { describe, it, expect } from "vitest";

import { MAX_SCOPED_PATH_LENGTH, validateScopedPathSyntax } from "../../src/collab/scope.js";
import { OutOfScopeError, type OutOfScopeReason } from "../../src/errors.js";

const AUTHORITATIVE_FILE_NAME = "spec.md";

function expectRefusal(rawPath: string, reason: OutOfScopeReason): OutOfScopeError {
  let caught: unknown;
  try {
    validateScopedPathSyntax(rawPath, AUTHORITATIVE_FILE_NAME);
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof OutOfScopeError)) {
    throw new Error(
      `Expected OutOfScopeError for ${JSON.stringify(rawPath)}, got ${String(caught)}`,
    );
  }
  expect(caught.reason).toBe(reason);
  expect(caught.attemptedPath).toBe(rawPath);
  return caught;
}

describe("validateScopedPathSyntax — §4.6 steps 1–5", () => {
  // -------------------------------------------------------------------------
  // Step 1: pre-normalisation refusals
  // -------------------------------------------------------------------------

  describe("step 1 — pre-normalisation refusals", () => {
    it("refuses an empty path", () => {
      expectRefusal("", "empty_path");
    });

    it("refuses a path longer than 1024 characters", () => {
      const tooLong = "a".repeat(MAX_SCOPED_PATH_LENGTH + 1);
      expectRefusal(tooLong, "path_too_long");
    });

    it("refuses NUL", () => {
      expectRefusal("foo\u0000.md", "control_character");
    });

    it("refuses CR", () => {
      expectRefusal("foo\r.md", "control_character");
    });

    it("refuses LF", () => {
      expectRefusal("foo\n.md", "control_character");
    });

    it("refuses other C0 control chars (0x01)", () => {
      expectRefusal("foo\u0001.md", "control_character");
    });

    it("refuses DEL (0x7f)", () => {
      expectRefusal("foo\u007f.md", "control_character");
    });

    it("refuses backslash", () => {
      expectRefusal("proposals\\foo.md", "backslash");
    });

    it("refuses a leading slash", () => {
      expectRefusal("/proposals/foo.md", "absolute_path");
    });

    it("refuses a Windows drive-letter prefix", () => {
      expectRefusal("C:/proposals/foo.md", "drive_letter");
    });

    it("refuses a backslashed drive-letter prefix", () => {
      expectRefusal("C:\\proposals\\foo.md", "drive_letter");
    });
  });

  // -------------------------------------------------------------------------
  // Step 2: URL-decode once
  // -------------------------------------------------------------------------

  describe("step 2 — URL-decode once", () => {
    it("refuses encoded `..` (`%2e%2e/foo.md`)", () => {
      // Decodes to `../foo.md` → caught by step 4 (dotdot_segment).
      expectRefusal("%2e%2e/foo.md", "dotdot_segment");
    });

    it("refuses single-encoded `%2f` traversal (`..%2f.collab/foo`)", () => {
      // Decodes to `../.collab/foo` → caught at step 4 dotdot_segment.
      expectRefusal("..%2ffoo.md", "dotdot_segment");
    });

    it("refuses double-encoded `..%252e` (`%` survives the decode)", () => {
      expectRefusal("%252e%252e/foo.md", "double_encoded");
    });

    it("refuses an encoded backslash (post-decode re-check)", () => {
      expectRefusal("proposals%5Cfoo.md", "backslash");
    });

    it("refuses an encoded leading slash (post-decode re-check)", () => {
      expectRefusal("%2fproposals/foo.md", "absolute_path");
    });

    it("refuses an encoded NUL (post-decode re-check)", () => {
      expectRefusal("foo%00.md", "control_character");
    });

    it("refuses a malformed escape sequence", () => {
      // `%E0%A4` is a partial UTF-8 sequence that decodeURIComponent rejects.
      expectRefusal("%E0%A4", "double_encoded");
    });
  });

  // -------------------------------------------------------------------------
  // Step 3: NFC / NFKC equality
  // -------------------------------------------------------------------------

  describe("step 3 — NFC / NFKC normalisation", () => {
    it("refuses full-width `．．` traversal", () => {
      // U+FF0E FULL-WIDTH FULL STOP repeated, NFKC-folds to "..".
      expectRefusal("．．/foo.md", "homoglyph_or_compatibility_form");
    });

    it("refuses full-width `／` separator", () => {
      // U+FF0F FULL-WIDTH SOLIDUS NFKC-folds to "/".
      expectRefusal("proposals／foo.md", "homoglyph_or_compatibility_form");
    });

    it("refuses an `ﬁ` ligature (NFKC compatibility decomposition)", () => {
      // U+FB01 LATIN SMALL LIGATURE FI NFKC-folds to "fi".
      expectRefusal("proposals/\uFB01le.md", "homoglyph_or_compatibility_form");
    });

    it("accepts an NFC-normalised non-ASCII filename", () => {
      const result = validateScopedPathSyntax("attachments/café.png", AUTHORITATIVE_FILE_NAME);
      expect(result.kind).toBe("attachments");
      expect(result.segments).toEqual(["attachments", "café".normalize("NFC") + ".png"]);
    });
  });

  // -------------------------------------------------------------------------
  // Step 4: segment validation
  // -------------------------------------------------------------------------

  describe("step 4 — segment validation", () => {
    it("refuses an empty segment (`//`)", () => {
      expectRefusal("proposals//foo.md", "empty_segment");
    });

    it("refuses a `.` segment", () => {
      expectRefusal("proposals/./foo.md", "dot_segment");
    });

    it("refuses a `..` segment", () => {
      expectRefusal("../foo.md", "dotdot_segment");
    });

    it("refuses a dot-prefixed segment (`.collab/foo`)", () => {
      expectRefusal(".collab/foo.md", "dot_prefixed_segment");
    });

    it("refuses a dot-prefixed leaf segment", () => {
      expectRefusal("attachments/.hidden", "dot_prefixed_segment");
    });
  });

  // -------------------------------------------------------------------------
  // Step 5: layout enforcement
  // -------------------------------------------------------------------------

  describe("step 5 — layout enforcement", () => {
    it("accepts the pinned authoritative file at the root", () => {
      const result = validateScopedPathSyntax("spec.md", AUTHORITATIVE_FILE_NAME);
      expect(result.kind).toBe("authoritative");
      expect(result.segments).toEqual(["spec.md"]);
    });

    it("refuses an unknown root file", () => {
      // "notes.md" is at the root but doesn't match the pinned name and
      // isn't one of the recognised group prefixes.
      expectRefusal("notes.md", "path_layout_violation");
    });

    it("refuses an unknown top-level group", () => {
      expectRefusal("random/foo.md", "path_layout_violation");
    });

    it("treats top-level group as case-sensitive (`Proposals/foo.md`)", () => {
      expectRefusal("Proposals/foo.md", "path_layout_violation");
    });

    it("accepts a flat `proposals/<name>.md`", () => {
      const result = validateScopedPathSyntax("proposals/foo.md", AUTHORITATIVE_FILE_NAME);
      expect(result.kind).toBe("proposals");
      expect(result.segments).toEqual(["proposals", "foo.md"]);
    });

    it("accepts a flat `drafts/<name>.md`", () => {
      const result = validateScopedPathSyntax("drafts/wip.md", AUTHORITATIVE_FILE_NAME);
      expect(result.kind).toBe("drafts");
    });

    it("refuses `proposals/foo.txt` (wrong extension)", () => {
      expectRefusal("proposals/foo.txt", "wrong_extension");
    });

    it("accepts `proposals/foo.MD` (case-insensitive .md check)", () => {
      const result = validateScopedPathSyntax("proposals/foo.MD", AUTHORITATIVE_FILE_NAME);
      expect(result.kind).toBe("proposals");
    });

    it("refuses a subfolder under `proposals/`", () => {
      expectRefusal("proposals/sub/foo.md", "subfolder_in_flat_group");
    });

    it("refuses a subfolder under `drafts/`", () => {
      expectRefusal("drafts/sub/foo.md", "subfolder_in_flat_group");
    });

    it("accepts arbitrary depth under `attachments/`", () => {
      const result = validateScopedPathSyntax(
        "attachments/sub/sub2/foo.png",
        AUTHORITATIVE_FILE_NAME,
      );
      expect(result.kind).toBe("attachments");
      expect(result.segments).toEqual(["attachments", "sub", "sub2", "foo.png"]);
    });

    it("accepts a flat `attachments/<file>` (no extension constraint)", () => {
      const result = validateScopedPathSyntax("attachments/diagram.svg", AUTHORITATIVE_FILE_NAME);
      expect(result.kind).toBe("attachments");
    });

    it("refuses the bare `attachments/` group", () => {
      expectRefusal("attachments", "path_layout_violation");
    });
  });
});
