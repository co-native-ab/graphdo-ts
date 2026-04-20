// Unit tests for the renewal-counts sliding-window persistence helper
// (`docs/plans/collab-v1.md` §3.5, W4 Day 5).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  RENEWAL_WINDOW_MS,
  MAX_RENEWALS_PER_WINDOW,
  RenewalCountsFileSchema,
  RenewalCountsParseError,
  loadRenewalCounts,
  pruneStale,
  recordRenewal,
  renewalCountsPath,
  renewalKey,
  saveRenewalCounts,
  windowCount,
} from "../../src/collab/renewal-counts.js";
import { testSignal } from "../helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "graphdo-renewal-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const KEY = renewalKey("00000000-0000-0000-0000-0000a3f2c891", "01JPROJECT00000000000000001");

describe("renewal-counts: constants", () => {
  it("RENEWAL_WINDOW_MS is exactly 24 hours", () => {
    expect(RENEWAL_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("MAX_RENEWALS_PER_WINDOW is 6 per the §3.5 cap", () => {
    expect(MAX_RENEWALS_PER_WINDOW).toBe(6);
  });
});

describe("renewal-counts: renewalKey", () => {
  it("composes <oid>/<projectId>", () => {
    expect(renewalKey("oid-1", "proj-2")).toBe("oid-1/proj-2");
  });

  it("rejects empty userOid", () => {
    expect(() => renewalKey("", "p")).toThrow(/userOid/);
  });

  it("rejects empty projectId", () => {
    expect(() => renewalKey("o", "")).toThrow(/projectId/);
  });
});

describe("renewal-counts: schema", () => {
  it("rejects unknown top-level fields (strict)", () => {
    const result = RenewalCountsFileSchema.safeParse({
      schemaVersion: 1,
      windows: {},
      extra: "no",
    });
    expect(result.success).toBe(false);
  });

  it("rejects schemaVersion !== 1", () => {
    const result = RenewalCountsFileSchema.safeParse({ schemaVersion: 2, windows: {} });
    expect(result.success).toBe(false);
  });

  it("rejects non-ISO timestamps", () => {
    const result = RenewalCountsFileSchema.safeParse({
      schemaVersion: 1,
      windows: { k: { renewals: ["not-a-date"] } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed file", () => {
    const result = RenewalCountsFileSchema.safeParse({
      schemaVersion: 1,
      windows: { k: { renewals: ["2026-04-19T05:00:00.000Z"] } },
    });
    expect(result.success).toBe(true);
  });
});

describe("renewal-counts: pruneStale", () => {
  const now = new Date("2026-04-20T12:00:00.000Z");

  it("drops timestamps older than 24h", () => {
    const file = {
      schemaVersion: 1 as const,
      windows: {
        k: {
          renewals: [
            "2026-04-19T11:00:00.000Z", // 25h ago — pruned
            "2026-04-19T13:00:00.000Z", // 23h ago — kept
            "2026-04-20T11:00:00.000Z", // 1h ago — kept
          ],
        },
      },
    };
    const pruned = pruneStale(file, now);
    expect(pruned.windows["k"]?.renewals).toEqual([
      "2026-04-19T13:00:00.000Z",
      "2026-04-20T11:00:00.000Z",
    ]);
  });

  it("drops the key entirely when its renewals array empties out", () => {
    const file = {
      schemaVersion: 1 as const,
      windows: {
        stale: { renewals: ["2026-04-18T00:00:00.000Z"] },
        fresh: { renewals: ["2026-04-20T11:00:00.000Z"] },
      },
    };
    const pruned = pruneStale(file, now);
    expect(pruned.windows["stale"]).toBeUndefined();
    expect(pruned.windows["fresh"]?.renewals).toHaveLength(1);
  });

  it("treats a timestamp exactly 24h old as stale (cutoff is exclusive)", () => {
    const file = {
      schemaVersion: 1 as const,
      windows: { k: { renewals: ["2026-04-19T12:00:00.000Z"] } },
    };
    expect(pruneStale(file, now).windows["k"]).toBeUndefined();
  });

  it("preserves schemaVersion", () => {
    const pruned = pruneStale({ schemaVersion: 1, windows: {} }, now);
    expect(pruned.schemaVersion).toBe(1);
  });
});

describe("renewal-counts: loadRenewalCounts", () => {
  it("returns an empty file when path does not exist", async () => {
    const now = new Date();
    const file = await loadRenewalCounts(tmpDir, now, testSignal());
    expect(file).toEqual({ schemaVersion: 1, windows: {} });
  });

  it("throws RenewalCountsParseError on malformed JSON", async () => {
    const filePath = renewalCountsPath(tmpDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not json", "utf-8");
    await expect(loadRenewalCounts(tmpDir, new Date(), testSignal())).rejects.toBeInstanceOf(
      RenewalCountsParseError,
    );
  });

  it("throws RenewalCountsParseError on schema mismatch", async () => {
    const filePath = renewalCountsPath(tmpDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, windows: {} }), "utf-8");
    await expect(loadRenewalCounts(tmpDir, new Date(), testSignal())).rejects.toBeInstanceOf(
      RenewalCountsParseError,
    );
  });

  it("prunes stale entries on read", async () => {
    const filePath = renewalCountsPath(tmpDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        windows: {
          old: { renewals: ["2026-04-18T00:00:00.000Z"] },
          fresh: { renewals: ["2026-04-20T11:00:00.000Z"] },
        },
      }),
      "utf-8",
    );
    const now = new Date("2026-04-20T12:00:00.000Z");
    const file = await loadRenewalCounts(tmpDir, now, testSignal());
    expect(file.windows["old"]).toBeUndefined();
    expect(file.windows["fresh"]?.renewals).toHaveLength(1);
  });
});

describe("renewal-counts: saveRenewalCounts", () => {
  it("writes atomically and re-reads cleanly", async () => {
    const now = new Date("2026-04-20T12:00:00.000Z");
    await saveRenewalCounts(
      tmpDir,
      {
        schemaVersion: 1,
        windows: { [KEY]: { renewals: ["2026-04-20T11:00:00.000Z"] } },
      },
      now,
      testSignal(),
    );
    const raw = await readFile(renewalCountsPath(tmpDir), "utf-8");
    const parsed = RenewalCountsFileSchema.parse(JSON.parse(raw));
    expect(parsed.windows[KEY]?.renewals).toHaveLength(1);
  });

  it("prunes stale entries on write", async () => {
    const now = new Date("2026-04-20T12:00:00.000Z");
    const saved = await saveRenewalCounts(
      tmpDir,
      {
        schemaVersion: 1,
        windows: {
          old: { renewals: ["2026-04-18T00:00:00.000Z"] },
          [KEY]: { renewals: ["2026-04-20T11:00:00.000Z"] },
        },
      },
      now,
      testSignal(),
    );
    expect(saved.windows["old"]).toBeUndefined();
    expect(saved.windows[KEY]?.renewals).toHaveLength(1);
  });
});

describe("renewal-counts: windowCount", () => {
  it("returns 0 for an unseen key", async () => {
    const count = await windowCount(tmpDir, KEY, new Date(), testSignal());
    expect(count).toBe(0);
  });

  it("returns the live count after recordRenewal", async () => {
    const now = new Date("2026-04-20T12:00:00.000Z");
    await recordRenewal(tmpDir, KEY, now, testSignal());
    expect(await windowCount(tmpDir, KEY, now, testSignal())).toBe(1);
    await recordRenewal(tmpDir, KEY, now, testSignal());
    expect(await windowCount(tmpDir, KEY, now, testSignal())).toBe(2);
  });

  it("decreases after the window slides past stale entries", async () => {
    const t0 = new Date("2026-04-19T11:00:00.000Z");
    await recordRenewal(tmpDir, KEY, t0, testSignal());
    expect(await windowCount(tmpDir, KEY, t0, testSignal())).toBe(1);

    const tMuchLater = new Date("2026-04-20T13:00:00.000Z"); // 26h later
    expect(await windowCount(tmpDir, KEY, tMuchLater, testSignal())).toBe(0);
  });
});

describe("renewal-counts: recordRenewal", () => {
  it("returns before/after counts and the written ts", async () => {
    const now = new Date("2026-04-20T12:00:00.000Z");
    const r1 = await recordRenewal(tmpDir, KEY, now, testSignal());
    expect(r1.windowCountBefore).toBe(0);
    expect(r1.windowCountAfter).toBe(1);
    expect(r1.ts).toBe(now.toISOString());

    const r2 = await recordRenewal(tmpDir, KEY, now, testSignal());
    expect(r2.windowCountBefore).toBe(1);
    expect(r2.windowCountAfter).toBe(2);
  });

  it("scopes counters per key — different (oid, projectId) pairs do not interfere", async () => {
    const keyA = renewalKey("oid-A", "proj-1");
    const keyB = renewalKey("oid-B", "proj-1");
    const now = new Date("2026-04-20T12:00:00.000Z");
    await recordRenewal(tmpDir, keyA, now, testSignal());
    await recordRenewal(tmpDir, keyA, now, testSignal());
    await recordRenewal(tmpDir, keyB, now, testSignal());
    expect(await windowCount(tmpDir, keyA, now, testSignal())).toBe(2);
    expect(await windowCount(tmpDir, keyB, now, testSignal())).toBe(1);
  });

  it("excludes stale entries from windowCountBefore (uses post-prune count)", async () => {
    // Seed an entry 25h in the past — it should be pruned on the next read.
    const past = new Date("2026-04-19T11:00:00.000Z");
    await recordRenewal(tmpDir, KEY, past, testSignal());

    const now = new Date("2026-04-20T12:00:00.000Z");
    const r = await recordRenewal(tmpDir, KEY, now, testSignal());
    expect(r.windowCountBefore).toBe(0);
    expect(r.windowCountAfter).toBe(1);
  });
});
