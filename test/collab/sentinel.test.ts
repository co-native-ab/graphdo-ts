// Sentinel codec tests (collab v1 §3.2 — W1 Day 2 plumbing).
//
// Pure unit-level coverage: round-trip JSON serialisation, schema rejection
// of unknown / malformed inputs, and the rename-tolerant pin comparator
// (`verifySentinelAgainstPin`). Graph I/O (`readSentinel`/`writeSentinel`)
// is exercised end-to-end by `test/integration/15-sentinel-tamper-detected.test.ts`
// and the upcoming W1 Day 3 init-flow scenario tests.

import { describe, it, expect } from "vitest";

import {
  ProjectSentinelSchema,
  SentinelParseError,
  SENTINEL_SCHEMA_VERSION,
  parseSentinel,
  serializeSentinel,
  verifySentinelAgainstPin,
  type ProjectSentinel,
  type SentinelPin,
} from "../../src/collab/sentinel.js";
import { SentinelTamperedError } from "../../src/errors.js";

function makeSentinel(overrides: Partial<ProjectSentinel> = {}): ProjectSentinel {
  return {
    schemaVersion: SENTINEL_SCHEMA_VERSION,
    projectId: "01JABCDE0FGHJKMNPQRSTV0WXY",
    authoritativeFileId: "01ABCDEF1234567890",
    authoritativeFileName: "spec.md",
    createdBy: { displayName: "Alice" },
    createdAt: "2026-04-19T05:00:00Z",
    ...overrides,
  };
}

function makePin(overrides: Partial<SentinelPin> = {}): SentinelPin {
  return {
    pinnedAuthoritativeFileId: "01ABCDEF1234567890",
    pinnedSentinelFirstSeenAt: "2026-04-19T05:00:00Z",
    pinnedAtFirstSeenCTag: '"c:{01ABCDEF1234567890},1"',
    displayAuthoritativeFileName: "spec.md",
    ...overrides,
  };
}

describe("sentinel codec", () => {
  describe("round-trip", () => {
    it("serialises and parses back to the original document", () => {
      const sentinel = makeSentinel();
      const raw = serializeSentinel(sentinel);
      const parsed = parseSentinel(raw);
      expect(parsed).toEqual(sentinel);
    });

    it("emits two-space indent and a trailing newline", () => {
      const raw = serializeSentinel(makeSentinel());
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw).toContain('\n  "projectId":');
      expect(raw).toContain('\n  "createdBy": {');
      expect(raw).toContain('\n    "displayName":');
    });

    it("preserves field values byte-for-byte through round-trip", () => {
      const sentinel = makeSentinel({
        authoritativeFileName: "Spec — v2 (réviewed).md",
        createdBy: { displayName: "Åsa Müller-O'Brien" },
      });
      const raw = serializeSentinel(sentinel);
      const parsed = parseSentinel(raw);
      expect(parsed.authoritativeFileName).toBe("Spec — v2 (réviewed).md");
      expect(parsed.createdBy.displayName).toBe("Åsa Müller-O'Brien");
    });
  });

  describe("schema validation", () => {
    it("rejects unknown top-level keys (strict schema, §2.5)", () => {
      const raw = JSON.stringify({
        ...makeSentinel(),
        smuggled: "should-be-rejected",
      });
      expect(() => parseSentinel(raw)).toThrow(SentinelParseError);
    });

    it("rejects identity claims on createdBy (no oid / username allowed, §3.2)", () => {
      const raw = JSON.stringify({
        ...makeSentinel(),
        createdBy: { displayName: "Alice", oid: "00000000-0000-0000-0000-000000000001" },
      });
      expect(() => parseSentinel(raw)).toThrow(SentinelParseError);
    });

    it("rejects schemaVersion other than 1", () => {
      const raw = JSON.stringify({ ...makeSentinel(), schemaVersion: 2 });
      expect(() => parseSentinel(raw)).toThrow(SentinelParseError);
    });

    it("rejects malformed JSON", () => {
      expect(() => parseSentinel("{not json")).toThrow(SentinelParseError);
    });

    it("rejects an empty authoritativeFileId", () => {
      const raw = JSON.stringify({ ...makeSentinel(), authoritativeFileId: "" });
      expect(() => parseSentinel(raw)).toThrow(SentinelParseError);
    });

    it("rejects an oversized body before parsing JSON", () => {
      const huge = "a".repeat(17 * 1024);
      expect(() => parseSentinel(huge)).toThrow(SentinelParseError);
    });

    it("serializeSentinel rejects an invalid sentinel constructed in code", () => {
      const bad = { ...makeSentinel(), authoritativeFileId: "" } as ProjectSentinel;
      expect(() => serializeSentinel(bad)).toThrow();
    });

    it("the schema is exported and re-usable as a Zod parser", () => {
      const parsed = ProjectSentinelSchema.parse(makeSentinel());
      expect(parsed.schemaVersion).toBe(1);
    });
  });

  describe("verifySentinelAgainstPin", () => {
    it("returns { kind: 'match' } when id and name agree with the pin", () => {
      const result = verifySentinelAgainstPin(makeSentinel(), makePin());
      expect(result).toEqual({ kind: "match" });
    });

    it("returns { kind: 'renamed' } when the file id matches but the name changed (rename-tolerant)", () => {
      const renamed = makeSentinel({ authoritativeFileName: "README.md" });
      const result = verifySentinelAgainstPin(renamed, makePin());
      expect(result).toEqual({
        kind: "renamed",
        refreshedDisplayAuthoritativeFileName: "README.md",
      });
    });

    it("throws SentinelTamperedError when authoritativeFileId differs from the pin", () => {
      const tampered = makeSentinel({ authoritativeFileId: "01TAMPERED9999" });
      expect(() => verifySentinelAgainstPin(tampered, makePin())).toThrow(SentinelTamperedError);
    });

    it("SentinelTamperedError carries the pinned and current ids and the pinned-at timestamp", () => {
      const tampered = makeSentinel({ authoritativeFileId: "01TAMPERED9999" });
      try {
        verifySentinelAgainstPin(tampered, makePin());
        throw new Error("expected SentinelTamperedError");
      } catch (err) {
        expect(err).toBeInstanceOf(SentinelTamperedError);
        const e = err as SentinelTamperedError;
        expect(e.pinnedAuthoritativeFileId).toBe("01ABCDEF1234567890");
        expect(e.currentAuthoritativeFileId).toBe("01TAMPERED9999");
        expect(e.pinnedSentinelFirstSeenAt).toBe("2026-04-19T05:00:00Z");
        expect(e.message).toContain("01ABCDEF1234567890");
        expect(e.message).toContain("01TAMPERED9999");
      }
    });

    it("treats id mismatch as tamper even when the displayed name still matches", () => {
      // Reproduces the §3.2 risk shape: a malicious cooperator who swaps the
      // authoritative file but renames the new one to the original display
      // name to mask the swap. The pin defends against this because the
      // comparison is id-based, not name-based.
      const tampered = makeSentinel({
        authoritativeFileId: "01TAMPERED9999",
        authoritativeFileName: "spec.md",
      });
      expect(() => verifySentinelAgainstPin(tampered, makePin())).toThrow(SentinelTamperedError);
    });
  });
});
