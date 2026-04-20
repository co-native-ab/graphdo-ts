// Unit tests for the leases sidecar codec (`docs/plans/collab-v1.md`
// §3.2.1). Slug-helper unit tests live in `test/collab/slug.test.ts`.

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

// Slug helper unit tests live in `test/collab/slug.test.ts` (extracted
// in W4 Day 1 alongside the §3.1 step-6 preamble synthetic + the
// {@link walkSections} body partitioner used by the authorship codec).
