// Unit tests for the leases sidecar codec (`docs/plans/collab-v1.md`
// §3.2.1) and the heading-slug helper (§3.1 steps 1–5).

import { describe, it, expect } from "vitest";

import {
  LEASES_FILE_NAME,
  LEASES_MAX_BYTES,
  LEASES_SCHEMA_VERSION,
  LeasesFileSchema,
  LeasesFileTooLargeError,
  LeasesParseError,
  assertLeasesWithinCap,
  emptyLeases,
  parseLeases,
  pruneExpiredLeases,
  serializeLeases,
} from "../../src/collab/leases.js";
import {
  EMPTY_HEADING_SYNTHETIC_SLUG,
  headingSlugSet,
  normaliseSectionId,
  slugifyHeading,
  slugifyHeadings,
} from "../../src/collab/slug.js";

describe("collab/leases — file naming", () => {
  it("LEASES_FILE_NAME is exactly leases.json", () => {
    expect(LEASES_FILE_NAME).toBe("leases.json");
  });
  it("LEASES_SCHEMA_VERSION is 1", () => {
    expect(LEASES_SCHEMA_VERSION).toBe(1);
  });
  it("LEASES_MAX_BYTES is 64 KB", () => {
    expect(LEASES_MAX_BYTES).toBe(64 * 1024);
  });
});

describe("collab/leases — codec round trip", () => {
  const sample = {
    schemaVersion: 1 as const,
    leases: [
      {
        sectionSlug: "intro",
        agentId: "abcd1234-cli-01jabcde",
        agentDisplayName: "GitHub Copilot CLI",
        acquiredAt: "2026-04-19T05:50:00Z",
        expiresAt: "2026-04-19T06:00:00Z",
      },
    ],
  };

  it("round-trips through serialize → parse losslessly", () => {
    const text = serializeLeases(sample);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"schemaVersion": 1');
    const parsed = parseLeases(text);
    expect(parsed).toEqual(sample);
  });

  it("emptyLeases() yields a valid schema-version-1 file with zero leases", () => {
    const empty = emptyLeases();
    expect(empty.schemaVersion).toBe(1);
    expect(empty.leases).toEqual([]);
    // Must round-trip cleanly through the strict codec.
    expect(parseLeases(serializeLeases(empty))).toEqual(empty);
  });
});

describe("collab/leases — strict-schema rejection", () => {
  it("rejects unknown top-level keys (.strict())", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      leases: [],
      smuggled: "extra",
    });
    expect(() => parseLeases(raw)).toThrow(LeasesParseError);
  });

  it("rejects unknown lease-entry keys (.strict())", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      leases: [
        {
          sectionSlug: "x",
          agentId: "a",
          agentDisplayName: "A",
          acquiredAt: "2026-04-19T05:00:00Z",
          expiresAt: "2026-04-19T06:00:00Z",
          extra: "smuggled",
        },
      ],
    });
    expect(() => parseLeases(raw)).toThrow(LeasesParseError);
  });

  it("rejects schemaVersion ≠ 1", () => {
    const raw = JSON.stringify({ schemaVersion: 2, leases: [] });
    expect(() => parseLeases(raw)).toThrow(LeasesParseError);
  });

  it("rejects empty sectionSlug", () => {
    const result = LeasesFileSchema.safeParse({
      schemaVersion: 1,
      leases: [
        {
          sectionSlug: "",
          agentId: "a",
          agentDisplayName: "A",
          acquiredAt: "2026-04-19T05:00:00Z",
          expiresAt: "2026-04-19T06:00:00Z",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed JSON before zod is called", () => {
    expect(() => parseLeases("{not json")).toThrow(LeasesParseError);
  });

  it("rejects bodies larger than LEASES_MAX_BYTES before parsing", () => {
    const big = "x".repeat(LEASES_MAX_BYTES + 1);
    expect(() => parseLeases(big)).toThrow(LeasesParseError);
  });
});

describe("collab/leases — pruneExpiredLeases", () => {
  const now = new Date("2026-04-19T06:30:00Z");

  it("drops entries whose expiresAt is at or before now", () => {
    const file = {
      schemaVersion: 1 as const,
      leases: [
        {
          sectionSlug: "fresh",
          agentId: "a",
          agentDisplayName: "A",
          acquiredAt: "2026-04-19T06:25:00Z",
          expiresAt: "2026-04-19T06:35:00Z",
        },
        {
          sectionSlug: "stale",
          agentId: "b",
          agentDisplayName: "B",
          acquiredAt: "2026-04-19T05:50:00Z",
          expiresAt: "2026-04-19T06:00:00Z",
        },
      ],
    };
    const pruned = pruneExpiredLeases(file, now);
    expect(pruned.leases.map((l) => l.sectionSlug)).toEqual(["fresh"]);
  });

  it("returns the same instance when nothing is pruned", () => {
    const file = {
      schemaVersion: 1 as const,
      leases: [
        {
          sectionSlug: "fresh",
          agentId: "a",
          agentDisplayName: "A",
          acquiredAt: "2026-04-19T06:25:00Z",
          expiresAt: "2026-04-19T06:35:00Z",
        },
      ],
    };
    const pruned = pruneExpiredLeases(file, now);
    expect(pruned).toBe(file);
  });

  it("entries with expiresAt exactly equal to now are dropped", () => {
    const file = {
      schemaVersion: 1 as const,
      leases: [
        {
          sectionSlug: "boundary",
          agentId: "a",
          agentDisplayName: "A",
          acquiredAt: "2026-04-19T06:00:00Z",
          expiresAt: now.toISOString(),
        },
      ],
    };
    expect(pruneExpiredLeases(file, now).leases).toEqual([]);
  });
});

describe("collab/leases — assertLeasesWithinCap", () => {
  it("does not throw under the cap", () => {
    expect(() => assertLeasesWithinCap("x".repeat(LEASES_MAX_BYTES))).not.toThrow();
  });

  it("throws LeasesFileTooLargeError above the cap", () => {
    expect(() => assertLeasesWithinCap("x".repeat(LEASES_MAX_BYTES + 1))).toThrow(
      LeasesFileTooLargeError,
    );
  });
});

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
