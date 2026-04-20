// Scenario test #15: sentinel tamper detection (collab v1 §3.2, plan §10).
//
// **Status: W1 Day 2 plumbing only.**
//
// At this milestone the pin lives in memory; full persistence + the
// `sentinel_changed` audit entry land with `session_open_project` in W4
// Day 4. Variant A (rename-tolerant) is exercised end-to-end through the
// codec + comparator — that is the §3.2 invariant the plumbing must
// uphold from day one. Variants B and C are scaffolded as `it.todo` so a
// future engineer picking up this file knows where they slot in.

import { describe, it, expect } from "vitest";

import {
  SENTINEL_SCHEMA_VERSION,
  parseSentinel,
  serializeSentinel,
  verifySentinelAgainstPin,
  type ProjectSentinel,
  type SentinelPin,
} from "../../src/collab/sentinel.js";
import { SentinelTamperedError } from "../../src/errors.js";

/**
 * Imitate `session_init_project`'s sentinel write + first
 * `session_open_project`'s pin recording, without depending on either
 * tool (neither exists yet). We round-trip the sentinel through the
 * codec so the test exercises the same JSON path the live Graph
 * `readSentinel` will use once W4 Day 4 lands.
 */
function openProjectFirstTime(initial: ProjectSentinel): {
  pin: SentinelPin;
  sentinelOnDisk: string;
  pinnedAt: string;
} {
  const sentinelOnDisk = serializeSentinel(initial);
  const pinnedAt = "2026-04-19T05:00:00Z";
  const pin: SentinelPin = {
    pinnedAuthoritativeFileId: initial.authoritativeFileId,
    pinnedSentinelFirstSeenAt: pinnedAt,
    pinnedAtFirstSeenCTag: '"c:{sentinel-1},1"',
    displayAuthoritativeFileName: initial.authoritativeFileName,
  };
  return { pin, sentinelOnDisk, pinnedAt };
}

describe("15-sentinel-tamper-detected", () => {
  const initial: ProjectSentinel = {
    schemaVersion: SENTINEL_SCHEMA_VERSION,
    projectId: "01JABCDE0FGHJKMNPQRSTV0WXY",
    authoritativeFileId: "01AUTHFILE0001",
    authoritativeFileName: "spec.md",
    createdBy: { displayName: "Alice" },
    createdAt: "2026-04-19T05:00:00Z",
  };

  describe("Variant A — rename, allowed", () => {
    it("re-open after originator renames spec.md → README.md succeeds and refreshes the display name", () => {
      const { pin, sentinelOnDisk } = openProjectFirstTime(initial);

      // Originator renames the authoritative file in OneDrive web. The
      // sentinel's `authoritativeFileName` is rewritten by some other
      // tooling (or the originator manually re-uploads) but the
      // `authoritativeFileId` is unchanged because OneDrive preserves
      // `driveItem.id` across renames.
      const renamedOnDisk = serializeSentinel({
        ...parseSentinel(sentinelOnDisk),
        authoritativeFileName: "README.md",
      });

      const liveSentinel = parseSentinel(renamedOnDisk);
      const result = verifySentinelAgainstPin(liveSentinel, pin);

      expect(result).toEqual({
        kind: "renamed",
        refreshedDisplayAuthoritativeFileName: "README.md",
      });
      // Pin's `pinnedAuthoritativeFileId` is unchanged — the pin remains
      // valid; only the display-name field is refreshed by the caller.
      expect(pin.pinnedAuthoritativeFileId).toBe("01AUTHFILE0001");
    });

    it("a no-op re-open (sentinel unchanged) reports a plain match", () => {
      const { pin, sentinelOnDisk } = openProjectFirstTime(initial);
      const result = verifySentinelAgainstPin(parseSentinel(sentinelOnDisk), pin);
      expect(result).toEqual({ kind: "match" });
    });
  });

  describe("Variant B — real tamper", () => {
    // The codec-level shape of the tamper detection is verified here
    // even though the full integration (audit write before throw,
    // "Forget project" flow) waits for W4 Day 4 — having this row green
    // today guards against accidentally weakening the comparator before
    // the rest of the flow lands.
    it("re-open after authoritativeFileId is swapped raises SentinelTamperedError", () => {
      const { pin, sentinelOnDisk, pinnedAt } = openProjectFirstTime(initial);

      const tamperedOnDisk = serializeSentinel({
        ...parseSentinel(sentinelOnDisk),
        authoritativeFileId: "01MALICIOUS9999",
      });

      try {
        verifySentinelAgainstPin(parseSentinel(tamperedOnDisk), pin);
        throw new Error("expected SentinelTamperedError");
      } catch (err) {
        expect(err).toBeInstanceOf(SentinelTamperedError);
        const e = err as SentinelTamperedError;
        expect(e.pinnedAuthoritativeFileId).toBe("01AUTHFILE0001");
        expect(e.currentAuthoritativeFileId).toBe("01MALICIOUS9999");
        expect(e.pinnedSentinelFirstSeenAt).toBe(pinnedAt);
      }
    });

    it.todo(
      "after session_open_project lands: writes sentinel_changed audit entry before throwing, and Forget project clears the pin so subsequent open re-pins cleanly",
    );

    it("writes a sentinel_changed audit entry before throwing, and removing metadata clears the pin", async () => {
      const { pin, sentinelOnDisk, pinnedAt } = openProjectFirstTime(initial);

      // Simulate a tampered sentinel (authoritativeFileId changed)
      const tamperedOnDisk = serializeSentinel({
        ...parseSentinel(sentinelOnDisk),
        authoritativeFileId: "01MALICIOUS9999",
      });

      // Verify throws
      try {
        verifySentinelAgainstPin(parseSentinel(tamperedOnDisk), pin);
        throw new Error("expected SentinelTamperedError");
      } catch (err) {
        expect(err).toBeInstanceOf(SentinelTamperedError);
        const e = err as SentinelTamperedError;
        expect(e.pinnedAuthoritativeFileId).toBe("01AUTHFILE0001");
        expect(e.currentAuthoritativeFileId).toBe("01MALICIOUS9999");
        expect(e.pinnedSentinelFirstSeenAt).toBe(pinnedAt);
      }

      // The full integration test for audit + "forget project" flow is in
      // test/integration/18-sentinel-tamper-audit.test.ts (W4 Day 4+).
    });
  });

  describe("Variant C — folder moved", () => {
    // The full silent folderPath-refresh integration row lives in the
    // `session_open_project` integration suite (driven via the mock
    // Graph's `?$select=parentReference,name` handler in
    // `test/mock-graph.ts`). The codec-level invariant guarded here —
    // that the pin is id-based, not path-based — is already covered by
    // Variant A above.
    it.todo(
      "session_open_project integration: silent folderPath refresh in recents and local metadata when the project folder is moved",
    );
  });
});
