// Unit tests for the strict markdown file-name validator.
//
// The validator is deliberately conservative: any accepted name must work
// on Linux, macOS, and Windows, must describe a file (not a path or a
// subdirectory), and must end in `.md`. Every rejection class has a
// dedicated test so regressions are obvious.

import { describe, it, expect } from "vitest";

import {
  MARKDOWN_FILE_NAME_RULES,
  MAX_MARKDOWN_FILE_NAME_LENGTH,
  assertValidMarkdownFileName,
  validateMarkdownFileName,
} from "../../src/graph/markdown.js";

function expectValid(name: string): void {
  const r = validateMarkdownFileName(name);
  expect(r.valid, `"${name}" should be valid but was rejected: ${r.valid ? "" : r.reason}`).toBe(
    true,
  );
}

function expectInvalid(name: unknown, reasonFragment: string): void {
  const r = validateMarkdownFileName(name);
  expect(r.valid, `"${String(name)}" should be rejected`).toBe(false);
  if (!r.valid) {
    expect(r.reason.toLowerCase()).toContain(reasonFragment.toLowerCase());
  }
}

describe("validateMarkdownFileName", () => {
  describe("accepts safe names", () => {
    for (const name of [
      "notes.md",
      "Notes.md",
      "NOTES.MD",
      "daily-log.md",
      "2026-04-17.md",
      "meeting_notes.md",
      "project v1.md",
      "a.md",
      "Hello World.md",
      "mix of upper-CASE_and.lower.md",
    ]) {
      it(`accepts "${name}"`, () => {
        expectValid(name);
      });
    }

    it("accepts a 255-char name (boundary)", () => {
      const stem = "a".repeat(MAX_MARKDOWN_FILE_NAME_LENGTH - 3);
      expectValid(`${stem}.md`);
    });
  });

  describe("rejects empty / wrong-type inputs", () => {
    it("rejects the empty string", () => {
      expectInvalid("", "must not be empty");
    });
    it("rejects non-string inputs", () => {
      expectInvalid(undefined, "must be a string");
      expectInvalid(null, "must be a string");
      expectInvalid(123, "must be a string");
    });
  });

  describe("rejects names without the .md extension", () => {
    it("rejects names with no extension", () => {
      expectInvalid("notes", "must end in .md");
    });
    it("rejects names with other extensions", () => {
      expectInvalid("notes.txt", "must end in .md");
      expectInvalid("notes.markdown", "must end in .md");
    });
    it("rejects the extension alone", () => {
      expectInvalid(".md", "content before the .md");
    });
  });

  describe("rejects path separators", () => {
    for (const name of [
      "foo/bar.md",
      "/absolute.md",
      "sub/dir/file.md",
      "sub\\file.md",
      "\\windows\\file.md",
      "../escape.md",
      "./here.md",
    ]) {
      it(`rejects "${name}"`, () => {
        expectInvalid(name, "path separator");
      });
    }
  });

  describe("rejects . and ..", () => {
    it("rejects '.'", () => {
      expectInvalid(".", "'.'");
    });
    it("rejects '..'", () => {
      expectInvalid("..", "'.'");
    });
  });

  describe("rejects unsafe / non-portable characters", () => {
    for (const name of [
      "foo:bar.md", // colon (Windows drive separator)
      "foo?.md", // wildcard
      "foo*.md", // wildcard
      "foo<bar>.md", // redirection
      'foo".md', // quote
      "foo|bar.md", // pipe
      "foo\tbar.md", // tab (control)
      "foo\u0000bar.md", // NUL
      "foo\u0007bar.md", // BEL
      "café.md", // non-ASCII letter
      "emoji 😀.md", // emoji
      "#hash.md", // # is not in allow-list
      "+plus.md",
      "(paren).md",
    ]) {
      it(`rejects "${name.replace(/\p{C}/gu, "?")}"`, () => {
        const r = validateMarkdownFileName(name);
        expect(r.valid).toBe(false);
      });
    }
  });

  describe("rejects whitespace edge cases", () => {
    it("rejects leading space", () => {
      expectInvalid(" file.md", "whitespace");
    });
    it("rejects trailing space before .md", () => {
      expectInvalid("file .md", "trailing whitespace before the .md");
    });
    it("rejects trailing whitespace overall", () => {
      expectInvalid("file.md ", "whitespace");
    });
  });

  describe("rejects leading-dot / leading-hyphen / purely-symbolic names", () => {
    it("rejects leading dot", () => {
      expectInvalid(".hidden.md", "first character must be a letter or digit");
    });
    it("rejects leading hyphen", () => {
      expectInvalid("-looks-like-a-flag.md", "first character must be a letter or digit");
    });
    it("rejects leading underscore", () => {
      expectInvalid("_underscored.md", "first character must be a letter or digit");
    });
  });

  describe("rejects trailing dot before .md", () => {
    it("rejects stem ending in .", () => {
      expectInvalid("foo..md", "trailing dot");
    });
  });

  describe("rejects Windows reserved device names", () => {
    for (const reserved of ["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"]) {
      it(`rejects "${reserved}.md"`, () => {
        expectInvalid(`${reserved}.md`, "reserved name");
      });
      it(`rejects "${reserved.toLowerCase()}.md"`, () => {
        expectInvalid(`${reserved.toLowerCase()}.md`, "reserved name");
      });
    }
    it("does not reject non-reserved lookalikes", () => {
      expectValid("COMet.md");
      expectValid("LPT10.md");
      expectValid("console.md");
    });
  });

  describe("rejects names over the length limit", () => {
    it("rejects a 256-char name", () => {
      const stem = "a".repeat(MAX_MARKDOWN_FILE_NAME_LENGTH - 2);
      expectInvalid(`${stem}.md`, "maximum length");
    });
  });
});

describe("assertValidMarkdownFileName", () => {
  it("returns the name on success", () => {
    expect(assertValidMarkdownFileName("ok.md")).toBe("ok.md");
  });
  it("throws with the offending name quoted and the reason included", () => {
    expect(() => assertValidMarkdownFileName("foo/bar.md")).toThrow(/foo\/bar\.md/);
    expect(() => assertValidMarkdownFileName("foo/bar.md")).toThrow(/path separator/);
  });
});

describe("MARKDOWN_FILE_NAME_RULES", () => {
  it("mentions the core constraints so tool descriptions are self-contained", () => {
    const s = MARKDOWN_FILE_NAME_RULES.toLowerCase();
    expect(s).toContain(".md");
    expect(s).toContain("letters");
    expect(s).toContain("digits");
    expect(s).toContain("path separator");
    expect(s).toContain("windows");
    expect(s).toContain("255");
  });
});
