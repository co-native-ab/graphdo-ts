// Unit tests for the heading-slug helper (`docs/plans/collab-v1.md`
// §3.1 steps 1–6) and the {@link walkSections} body partitioner used
// by the authorship codec (W4 Day 1).
//
// These tests cover the slug surface that lands in W4 Day 1; the
// destructive matrix and slug-drift fallback live in
// `test/collab/authorship.test.ts`.

import { describe, it, expect } from "vitest";

import {
  EMPTY_HEADING_SYNTHETIC_SLUG,
  PREAMBLE_SYNTHETIC_SLUG,
  headingSlugSet,
  normaliseSectionId,
  slugifyHeading,
  slugifyHeadings,
  walkSections,
} from "../../src/collab/slug.js";

// ---------------------------------------------------------------------------
// Slug helper (§3.1 steps 1–5)
// ---------------------------------------------------------------------------

describe("collab/slug — slugifyHeading", () => {
  it("lowercases ASCII headings", () => {
    expect(slugifyHeading("Introduction")).toBe("introduction");
  });

  it("strips leading hashes and surrounding whitespace", () => {
    expect(slugifyHeading("## Introduction")).toBe("introduction");
    expect(slugifyHeading("####   Deeper Heading   ")).toBe("deeper-heading");
  });

  it("replaces whitespace runs with a single dash", () => {
    expect(slugifyHeading("Hello   World  ")).toBe("hello-world");
  });

  it("ASCII-folds accented characters via NFKD", () => {
    expect(slugifyHeading("Café au lait")).toBe("cafe-au-lait");
  });

  it("drops punctuation outside [a-z0-9-_]", () => {
    expect(slugifyHeading("v1.0 (RC)!")).toBe("v10-rc");
  });

  it("preserves underscores and existing dashes", () => {
    expect(slugifyHeading("snake_case-and-dashes")).toBe("snake_case-and-dashes");
  });

  it("collapses repeated dashes and trims them at the edges", () => {
    expect(slugifyHeading("---weird---")).toBe("weird");
  });

  it("returns the synthetic slug for hash-only headings", () => {
    expect(slugifyHeading("##")).toBe(EMPTY_HEADING_SYNTHETIC_SLUG);
    expect(slugifyHeading("###    ")).toBe(EMPTY_HEADING_SYNTHETIC_SLUG);
  });

  it("returns the synthetic slug for headings that slugify to empty", () => {
    expect(slugifyHeading("***")).toBe(EMPTY_HEADING_SYNTHETIC_SLUG);
  });
});

describe("collab/slug — slugifyHeadings", () => {
  it("collects ATX headings in source order", () => {
    const body = "# Top\n\n## Middle\n\nbody text\n\n### Bottom\n";
    expect(slugifyHeadings(body)).toEqual(["top", "middle", "bottom"]);
  });

  it("applies the collision walk on duplicate slugs", () => {
    const body = "# Same\n\n## Same\n\n### Same\n";
    expect(slugifyHeadings(body)).toEqual(["same", "same-1", "same-2"]);
  });

  it("ignores setext headings (only ATX is parsed in v1)", () => {
    const body = "Top\n===\n\n# ATX\n";
    expect(slugifyHeadings(body)).toEqual(["atx"]);
  });

  it("ignores non-heading lines", () => {
    expect(slugifyHeadings("# Real\nplain prose\n## Also real\n")).toEqual(["real", "also-real"]);
  });

  it("renames re-shift duplicate slugs across documents (insertion case)", () => {
    // Inserting a `## Introduction` above the existing one renumbers
    // the old from "introduction" to "introduction-1". The slug-drift
    // fallback in `findSectionByAnchor` exists precisely for this case.
    const before = "# Project\n\n## Introduction\nAlpha.\n";
    const after = "# Project\n\n## Introduction\nNEW.\n\n## Introduction\nAlpha.\n";
    expect(slugifyHeadings(before)).toEqual(["project", "introduction"]);
    expect(slugifyHeadings(after)).toEqual(["project", "introduction", "introduction-1"]);
  });
});

describe("collab/slug — headingSlugSet + normaliseSectionId", () => {
  it("headingSlugSet returns unique post-collision slugs", () => {
    const set = headingSlugSet("# Same\n## Same\n");
    expect(set.has("same")).toBe(true);
    expect(set.has("same-1")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("normaliseSectionId accepts raw headings or slugs", () => {
    expect(normaliseSectionId("introduction")).toBe("introduction");
    expect(normaliseSectionId("## Introduction")).toBe("introduction");
    expect(normaliseSectionId("Introduction")).toBe("introduction");
  });
});

// ---------------------------------------------------------------------------
// Section walker (§3.1 step 6 + §2.3 step 3)
// ---------------------------------------------------------------------------

describe("collab/slug — walkSections", () => {
  it("emits a synthetic preamble even when the body is empty", () => {
    const sections = walkSections("");
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      slug: PREAMBLE_SYNTHETIC_SLUG,
      level: 0,
      headingText: null,
      headingLine: null,
      bodyStart: 0,
      bodyEnd: 0,
    });
  });

  it("uses __preamble__ for prose before the first heading", () => {
    const body = "Some intro prose.\n\n# First Heading\nbody.\n";
    const sections = walkSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      slug: PREAMBLE_SYNTHETIC_SLUG,
      level: 0,
      bodyStart: 0,
      bodyEnd: body.indexOf("# First Heading"),
    });
    expect(sections[1]).toMatchObject({
      slug: "first-heading",
      level: 1,
      headingText: "First Heading",
    });
    // Section body covers everything after the heading line.
    expect(body.slice(sections[1]!.bodyStart, sections[1]!.bodyEnd)).toBe("body.\n");
  });

  it("emits an empty preamble entry when the body starts with a heading", () => {
    const body = "# Top\n\nbody.\n";
    const sections = walkSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      slug: PREAMBLE_SYNTHETIC_SLUG,
      bodyStart: 0,
      bodyEnd: 0,
    });
    expect(sections[1]?.slug).toBe("top");
  });

  it("ends a section at the next equal-or-shallower heading, not at deeper sub-headings", () => {
    const body = [
      "# Top",
      "",
      "top body",
      "",
      "## Sub A",
      "",
      "sub a body",
      "",
      "### Deep",
      "",
      "deep body",
      "",
      "## Sub B",
      "",
      "sub b body",
      "",
      "# Top 2",
      "",
      "top 2 body",
      "",
    ].join("\n");
    const sections = walkSections(body);
    const slugs = sections.map((s) => s.slug);
    expect(slugs).toEqual([PREAMBLE_SYNTHETIC_SLUG, "top", "sub-a", "deep", "sub-b", "top-2"]);

    // "top" should swallow Sub A + Deep + Sub B.
    const top = sections.find((s) => s.slug === "top")!;
    const top2 = sections.find((s) => s.slug === "top-2")!;
    const topBody = body.slice(top.bodyStart, top.bodyEnd);
    expect(topBody).toContain("top body");
    expect(topBody).toContain("## Sub A");
    expect(topBody).toContain("### Deep");
    expect(topBody).toContain("## Sub B");
    expect(topBody).not.toContain("# Top 2");
    // top.bodyEnd is the start of the next sibling/parent heading line.
    expect(body.slice(top.bodyEnd, top.bodyEnd + "# Top 2".length)).toBe("# Top 2");

    // "sub-a" ends at "## Sub B" (same level), not at "### Deep" (deeper).
    const subA = sections.find((s) => s.slug === "sub-a")!;
    const subABody = body.slice(subA.bodyStart, subA.bodyEnd);
    expect(subABody).toContain("sub a body");
    expect(subABody).toContain("### Deep");
    expect(subABody).not.toContain("## Sub B");

    // "top-2" runs to end of body.
    expect(top2.bodyEnd).toBe(body.length);
  });

  it("applies the collision walk inside the section list", () => {
    const body = "# Same\nbody one\n## Same\nbody two\n";
    const sections = walkSections(body);
    expect(sections.map((s) => s.slug)).toEqual([PREAMBLE_SYNTHETIC_SLUG, "same", "same-1"]);
  });

  it("captures the heading line offset for each section", () => {
    const body = "preamble\n# Heading\nbody\n";
    const sections = walkSections(body);
    expect(sections[1]?.headingLine).toBe(body.indexOf("# Heading"));
    expect(sections[1]?.headingText).toBe("Heading");
  });
});
