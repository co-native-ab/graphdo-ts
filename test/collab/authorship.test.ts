// Unit tests for the authorship-on-section codec (`docs/plans/collab-v1.md`
// §3.1, §2.3 `collab_apply_proposal`). Slug helper / section walker
// tests live in `test/collab/slug.test.ts`.

import { createHash } from "node:crypto";

import { describe, it, expect } from "vitest";

import {
  AuthorshipMatchReason,
  SECTION_HASH_PREFIX,
  classifyAuthorshipMatch,
  computeSectionContentHash,
  findSectionByAnchor,
  walkSectionsWithHashes,
} from "../../src/collab/authorship.js";
import type { FrontmatterAuthorship } from "../../src/collab/frontmatter.js";
import { PREAMBLE_SYNTHETIC_SLUG } from "../../src/collab/slug.js";

// ---------------------------------------------------------------------------
// Section content hash + walker
// ---------------------------------------------------------------------------

describe("collab/authorship — computeSectionContentHash", () => {
  it("returns a sha256:<64-hex> string", () => {
    const hash = computeSectionContentHash("hello world\n");
    expect(hash.startsWith(SECTION_HASH_PREFIX)).toBe(true);
    expect(hash.slice(SECTION_HASH_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("matches Node's createHash sha256 over UTF-8 bytes", () => {
    const body = "Hello, café!\n";
    const expected = `${SECTION_HASH_PREFIX}${createHash("sha256").update(body, "utf8").digest("hex")}`;
    expect(computeSectionContentHash(body)).toBe(expected);
  });

  it("treats trailing newlines as significant", () => {
    expect(computeSectionContentHash("body")).not.toBe(computeSectionContentHash("body\n"));
  });

  it("hashes the empty string deterministically", () => {
    // SHA-256 of the empty input is well-known.
    expect(computeSectionContentHash("")).toBe(
      `${SECTION_HASH_PREFIX}e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    );
  });
});

describe("collab/authorship — walkSectionsWithHashes", () => {
  it("emits a preamble plus one entry per ATX heading, each with a stable hash", () => {
    const body = "intro prose\n\n# Top\nbody A\n\n## Sub\nbody B\n";
    const sections = walkSectionsWithHashes(body);
    expect(sections.map((s) => s.slug)).toEqual([PREAMBLE_SYNTHETIC_SLUG, "top", "sub"]);

    // Each contentHash must equal computeSectionContentHash on the
    // bytes between bodyStart and bodyEnd.
    for (const section of sections) {
      expect(section.contentHash).toBe(
        computeSectionContentHash(body.slice(section.bodyStart, section.bodyEnd)),
      );
    }
  });

  it("renaming a heading changes the slug but keeps the body hash", () => {
    const before = "# Introduction\nthe same body\n";
    const after = "# Overview\nthe same body\n";
    const beforeSection = walkSectionsWithHashes(before).find((s) => s.slug === "introduction")!;
    const afterSection = walkSectionsWithHashes(after).find((s) => s.slug === "overview")!;
    expect(beforeSection.contentHash).toBe(afterSection.contentHash);
  });

  it("editing the body changes the hash even when the slug is stable", () => {
    const before = walkSectionsWithHashes("# Section\nalpha\n").find((s) => s.slug === "section")!;
    const after = walkSectionsWithHashes("# Section\nbeta\n").find((s) => s.slug === "section")!;
    expect(before.contentHash).not.toBe(after.contentHash);
  });

  it("deeper sub-headings are part of the parent section's hash", () => {
    const a = walkSectionsWithHashes("# Top\nbody\n## Sub\nsub body\n").find(
      (s) => s.slug === "top",
    )!;
    const b = walkSectionsWithHashes("# Top\nbody\n").find((s) => s.slug === "top")!;
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

// ---------------------------------------------------------------------------
// Slug-first / content-hash fallback (§2.3 step 2)
// ---------------------------------------------------------------------------

describe("collab/authorship — findSectionByAnchor", () => {
  const body = [
    "# Project",
    "",
    "preamble.",
    "",
    "## Introduction",
    "",
    "the introduction body",
    "",
    "## Details",
    "",
    "details body",
    "",
  ].join("\n");

  it("returns slug_match when the proposal slug names exactly one heading", () => {
    const result = findSectionByAnchor(body, "introduction", "ignored");
    expect(result.kind).toBe("slug_match");
    if (result.kind === "slug_match") {
      expect(result.section.slug).toBe("introduction");
    }
  });

  it("returns slug_drift_resolved when the slug is gone but the hash matches", () => {
    // The author's proposal recorded the introduction's body hash.
    const original = walkSectionsWithHashes(body).find((s) => s.slug === "introduction")!;
    // Human renames `## Introduction` to `## Overview` in OneDrive.
    const renamed = body.replace("## Introduction", "## Overview");
    const result = findSectionByAnchor(renamed, "introduction", original.contentHash);
    expect(result.kind).toBe("slug_drift_resolved");
    if (result.kind === "slug_drift_resolved") {
      expect(result.oldSlug).toBe("introduction");
      expect(result.newSlug).toBe("overview");
      expect(result.section.contentHash).toBe(original.contentHash);
    }
  });

  it("returns anchor_lost when neither the slug nor the hash match", () => {
    const result = findSectionByAnchor(
      body,
      "nonexistent",
      `${SECTION_HASH_PREFIX}${"0".repeat(64)}`,
    );
    expect(result.kind).toBe("anchor_lost");
    if (result.kind === "anchor_lost") {
      expect(result.oldSlug).toBe("nonexistent");
      expect(result.currentSlugs).toContain("introduction");
      expect(result.currentSlugs).toContain("details");
      // Empty preamble entries should not appear in the hint.
      expect(result.currentSlugs).not.toContain(PREAMBLE_SYNTHETIC_SLUG);
    }
  });

  it("returns slug_match for the post-collision slug even after a duplicate insertion shifted the numbering", () => {
    // After the collision walk, slugs are unique by construction, so
    // {@link findSectionByAnchor} always lands on `slug_match` whenever
    // the supplied slug names exactly one (post-walk) heading. The
    // "wrong section" case for an originally-`same` proposal that now
    // points at a fresh insertion is caught by `classifyAuthorshipMatch`
    // (case b: matching slug + different hash → slug-only conservative
    // match), not by the anchor lookup. The plan §2.3 step 2 only falls
    // back to the content-hash anchor when the slug literally matches
    // **zero** sections.
    const ambiguous = "# Top\n\n## Same\nfirst\n\n## Same\nsecond\n";
    const sameMatch = findSectionByAnchor(ambiguous, "same");
    expect(sameMatch.kind).toBe("slug_match");
    const renumbered = findSectionByAnchor(ambiguous, "same-1");
    expect(renumbered.kind).toBe("slug_match");
  });

  it("falls back to the recorded content hash for a renamed duplicate that no longer matches any slug", () => {
    // Original body had a single `## Same` section; proposal records
    // its hash. Then the human renames it to `## Renamed` and inserts
    // an unrelated `## Same` elsewhere. The proposal's slug `same`
    // resolves to the unrelated insertion's body — but the recorded
    // hash uniquely points at the renamed section, so the function
    // would still return slug_match (the slug uniquely names a section).
    // The slug-drift fallback only fires when the slug names **zero**
    // current sections, so we drop the slug here to model the rename
    // path explicitly.
    const before = "# Top\n\n## Same\nalpha\n";
    const beforeSection = walkSectionsWithHashes(before).find((s) => s.slug === "same")!;
    const afterRename = "# Top\n\n## Renamed Heading\nalpha\n";
    const result = findSectionByAnchor(afterRename, "same", beforeSection.contentHash);
    expect(result.kind).toBe("slug_drift_resolved");
    if (result.kind === "slug_drift_resolved") {
      expect(result.newSlug).toBe("renamed-heading");
    }
  });

  it("falls through to anchor_lost when contentHashAtCreate is omitted and the slug does not match", () => {
    const result = findSectionByAnchor(body, "missing");
    expect(result.kind).toBe("anchor_lost");
    if (result.kind === "anchor_lost") {
      expect(result.contentHashAtCreate).toBe("");
    }
  });

  it("works against the synthetic preamble slug", () => {
    const text = "preamble bytes\n\n# Heading\nbody\n";
    const result = findSectionByAnchor(text, PREAMBLE_SYNTHETIC_SLUG);
    expect(result.kind).toBe("slug_match");
    if (result.kind === "slug_match") {
      expect(result.section.slug).toBe(PREAMBLE_SYNTHETIC_SLUG);
      // Preamble body covers everything before the first heading.
      expect(text.slice(result.section.bodyStart, result.section.bodyEnd)).toBe(
        "preamble bytes\n\n",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Destructive-detection over `frontmatter.authorship[]` (§2.3 step 4)
// ---------------------------------------------------------------------------

const CURRENT_AGENT = "agent-claude-current";
const OTHER_AGENT = "agent-cursor-other";

function entry(overrides: Partial<FrontmatterAuthorship> = {}): FrontmatterAuthorship {
  return {
    target_section_slug: "intro",
    section_content_hash: `${SECTION_HASH_PREFIX}${"a".repeat(64)}`,
    author_kind: "agent",
    author_agent_id: CURRENT_AGENT,
    author_display_name: "Claude (current)",
    written_at: "2026-04-19T05:50:00Z",
    revision: 1,
    ...overrides,
  };
}

describe("collab/authorship — classifyAuthorshipMatch", () => {
  const slug = "intro";
  const hash = `${SECTION_HASH_PREFIX}${"a".repeat(64)}`;

  it("empty authorship trail → not destructive", () => {
    const result = classifyAuthorshipMatch([], slug, hash, CURRENT_AGENT);
    expect(result).toEqual({ destructive: false, matches: [] });
  });

  it("matching slug + matching hash + same agent → not destructive (case a)", () => {
    const trail = [entry({ author_agent_id: CURRENT_AGENT })];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result.destructive).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.reason).toBe(AuthorshipMatchReason.SlugAndHash);
  });

  it("matching slug + matching hash + different agent → destructive (case a)", () => {
    const trail = [entry({ author_agent_id: OTHER_AGENT })];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result.destructive).toBe(true);
  });

  it("matching slug + matching hash + human author → destructive (case a)", () => {
    const trail = [entry({ author_kind: "human", author_agent_id: CURRENT_AGENT })];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result.destructive).toBe(true);
  });

  it("matching slug + different hash, no exact-hash match → conservative slug-only match (case b)", () => {
    // Trail says current agent wrote `intro` at hash X; current state
    // has hash Y. Plan: "treat as already-touched" — the worst case is a
    // spurious re-prompt. Same-agent slug-only match should NOT be
    // destructive (we wrote it last, just at a different hash).
    const trail = [entry({ section_content_hash: `${SECTION_HASH_PREFIX}${"b".repeat(64)}` })];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result.destructive).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.reason).toBe(AuthorshipMatchReason.SlugOnly);
  });

  it("matching slug + different hash + different agent → destructive via slug-only (case b)", () => {
    const trail = [
      entry({
        author_agent_id: OTHER_AGENT,
        section_content_hash: `${SECTION_HASH_PREFIX}${"b".repeat(64)}`,
      }),
    ];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result.destructive).toBe(true);
    expect(result.matches[0]?.reason).toBe(AuthorshipMatchReason.SlugOnly);
  });

  it("different slug + matching hash → destructive when other agent wrote it (case c)", () => {
    // Section was renamed but body hash still matches a prior write
    // by another agent.
    const trail = [entry({ target_section_slug: "old-name", author_agent_id: OTHER_AGENT })];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result.destructive).toBe(true);
    expect(result.matches[0]?.reason).toBe(AuthorshipMatchReason.HashOnly);
  });

  it("prefers exact slug+hash matches over slug-only matches", () => {
    // Both an exact (a) match and a slug-only (b) candidate exist in the
    // trail; the exact match should win and the slug-only entry should
    // not appear.
    const trail = [
      entry({ section_content_hash: `${SECTION_HASH_PREFIX}${"b".repeat(64)}` }),
      entry({ section_content_hash: hash, author_agent_id: OTHER_AGENT }),
    ];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result.matches.map((m) => m.reason)).toEqual([AuthorshipMatchReason.SlugAndHash]);
    expect(result.destructive).toBe(true);
  });

  it("collects hash-only matches alongside slug+hash matches without duplicates", () => {
    // One entry matches slug+hash, another (different slug) matches only
    // by hash. Both should be returned, deduplicated by entry identity.
    const slugAndHash = entry({ author_agent_id: OTHER_AGENT });
    const hashOnly = entry({
      target_section_slug: "renamed-twin",
      author_agent_id: CURRENT_AGENT,
    });
    const trail = [slugAndHash, hashOnly];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((m) => m.reason)).toEqual([
      AuthorshipMatchReason.SlugAndHash,
      AuthorshipMatchReason.HashOnly,
    ]);
    expect(result.destructive).toBe(true);
  });

  it("ignores trail entries that match neither slug nor hash", () => {
    const trail = [
      entry({
        target_section_slug: "unrelated",
        section_content_hash: `${SECTION_HASH_PREFIX}${"c".repeat(64)}`,
        author_agent_id: OTHER_AGENT,
      }),
    ];
    const result = classifyAuthorshipMatch(trail, slug, hash, CURRENT_AGENT);
    expect(result).toEqual({ destructive: false, matches: [] });
  });
});
