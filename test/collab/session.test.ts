// Unit tests for the in-memory session model + destructive-counter
// persistence helper (`docs/plans/collab-v1.md` §2.2, §3.7, W1 Day 5).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_DESTRUCTIVE_BUDGET,
  DEFAULT_TTL_SECONDS,
  DEFAULT_WRITE_BUDGET,
  MAX_DESTRUCTIVE_BUDGET,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  NoActiveSessionError,
  SessionAlreadyActiveError,
  SessionRegistry,
  deriveAgentId,
  slugifyClientName,
} from "../../src/collab/session.js";
import {
  destructiveCountsPath,
  loadDestructiveCounts,
  pruneStale,
  removeDestructiveCount,
  saveDestructiveCounts,
  upsertDestructiveCount,
  STALE_GRACE_MS,
} from "../../src/collab/session-counts.js";
import { testSignal } from "../helpers.js";

// ---------------------------------------------------------------------------
// Fake clock helper
// ---------------------------------------------------------------------------

class FakeClock {
  constructor(public ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  advanceMs(delta: number): void {
    this.ms += delta;
  }
  advanceSeconds(delta: number): void {
    this.ms += delta * 1000;
  }
}

// Deterministic sessionId generator so tests can assert on agentId.
function newSessionIdFactory(prefix = "01JTEST"): () => string {
  let n = 0;
  return () => {
    n += 1;
    // ULID is 26 base32 chars; we just need a non-empty unique string.
    return `${prefix}${String(n).padStart(19, "0")}`;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "graphdo-session-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// slugifyClientName + deriveAgentId
// ---------------------------------------------------------------------------

describe("slugifyClientName", () => {
  it("lowercases and slugifies known MCP client names", () => {
    expect(slugifyClientName("Claude-Desktop")).toBe("claude-desktop");
    expect(slugifyClientName("Claude Desktop")).toBe("claude-desktop");
    expect(slugifyClientName("vscode")).toBe("vscode");
    expect(slugifyClientName("Claude Code")).toBe("claude-code");
  });

  it("collapses runs and trims edge slugs", () => {
    expect(slugifyClientName("  Foo!!!  Bar  ")).toBe("foo-bar");
    expect(slugifyClientName("--leading--trailing--")).toBe("leading-trailing");
  });

  it("falls back to 'unknown' on empty / non-slug input", () => {
    expect(slugifyClientName(undefined)).toBe("unknown");
    expect(slugifyClientName(null)).toBe("unknown");
    expect(slugifyClientName("")).toBe("unknown");
    expect(slugifyClientName("!!!")).toBe("unknown");
    expect(slugifyClientName("---")).toBe("unknown");
  });
});

describe("deriveAgentId", () => {
  it("composes <oidPrefix>-<clientSlug>-<sessionIdPrefix>", () => {
    const agentId = deriveAgentId(
      "00000000-0000-0000-0000-0000a3f2c891",
      "claude-desktop",
      "01JABCDE0FGHJKMNPQRSTV0WXY",
    );
    // OID with hyphens stripped, first 8 chars: "00000000".
    // Session prefix is first 8 chars lowercased: "01jabcde".
    expect(agentId).toBe("00000000-claude-desktop-01jabcde");
  });

  it("handles short session ids by truncating to <=8 chars", () => {
    expect(deriveAgentId("aaaa-bbbb", "vscode", "ABC")).toBe("aaaabbbb-vscode-abc");
  });
});

// ---------------------------------------------------------------------------
// Destructive-counter persistence helper
// ---------------------------------------------------------------------------

describe("destructive-counts persistence", () => {
  it("returns an empty file when the sidecar does not yet exist", async () => {
    const file = await loadDestructiveCounts(tmpDir, new Date(), testSignal());
    expect(file).toEqual({ schemaVersion: 1, sessions: {} });
  });

  it("round-trips a single session entry across save -> load (simulated process restart)", async () => {
    const now = new Date("2026-04-19T05:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    await saveDestructiveCounts(
      tmpDir,
      {
        schemaVersion: 1,
        sessions: {
          "01JSESSION0000000000000001": {
            projectId: "01JPROJECT00000000000000001",
            destructiveBudgetTotal: 10,
            destructiveUsed: 3,
            writeBudgetTotal: 50,
            writesUsed: 12,
            expiresAt,
            renewalsUsed: 1,
          },
        },
      },
      now,
      testSignal(),
    );

    // Simulated restart: read fresh from disk, no in-memory state carried.
    const reloaded = await loadDestructiveCounts(tmpDir, now, testSignal());
    expect(reloaded.sessions["01JSESSION0000000000000001"]).toMatchObject({
      projectId: "01JPROJECT00000000000000001",
      destructiveUsed: 3,
      writesUsed: 12,
      renewalsUsed: 1,
    });

    // File on disk is well-formed JSON with schemaVersion 1.
    const raw = await readFile(destructiveCountsPath(tmpDir), "utf-8");
    const parsed = JSON.parse(raw) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });

  it("upsertDestructiveCount adds new entries and overwrites existing ones", async () => {
    const now = new Date("2026-04-19T05:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    await upsertDestructiveCount(
      tmpDir,
      "01JS0000000000000000000001",
      {
        projectId: "01JP00000000000000000000001",
        destructiveBudgetTotal: 10,
        destructiveUsed: 0,
        writeBudgetTotal: 50,
        writesUsed: 0,
        expiresAt,
        renewalsUsed: 0,
      },
      now,
      testSignal(),
    );
    await upsertDestructiveCount(
      tmpDir,
      "01JS0000000000000000000001",
      {
        projectId: "01JP00000000000000000000001",
        destructiveBudgetTotal: 10,
        destructiveUsed: 5,
        writeBudgetTotal: 50,
        writesUsed: 7,
        expiresAt,
        renewalsUsed: 0,
      },
      now,
      testSignal(),
    );
    const file = await loadDestructiveCounts(tmpDir, now, testSignal());
    expect(file.sessions["01JS0000000000000000000001"]?.destructiveUsed).toBe(5);
    expect(file.sessions["01JS0000000000000000000001"]?.writesUsed).toBe(7);
  });

  it("removeDestructiveCount drops the entry on session_end", async () => {
    const now = new Date("2026-04-19T05:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    await upsertDestructiveCount(
      tmpDir,
      "01JS0000000000000000000001",
      {
        projectId: "01JP00000000000000000000001",
        destructiveBudgetTotal: 10,
        destructiveUsed: 1,
        writeBudgetTotal: 50,
        writesUsed: 0,
        expiresAt,
        renewalsUsed: 0,
      },
      now,
      testSignal(),
    );
    await removeDestructiveCount(tmpDir, "01JS0000000000000000000001", now, testSignal());
    const file = await loadDestructiveCounts(tmpDir, now, testSignal());
    expect(file.sessions).toEqual({});
  });

  it("prunes entries with expiresAt < now - 24h on read and write", () => {
    const now = new Date("2026-04-20T05:00:00.000Z");
    const fresh = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const stale = new Date(now.getTime() - STALE_GRACE_MS - 1000).toISOString();

    const pruned = pruneStale(
      {
        schemaVersion: 1,
        sessions: {
          fresh: {
            projectId: "p1",
            destructiveBudgetTotal: 10,
            destructiveUsed: 0,
            writeBudgetTotal: 50,
            writesUsed: 0,
            expiresAt: fresh,
            renewalsUsed: 0,
          },
          stale: {
            projectId: "p2",
            destructiveBudgetTotal: 10,
            destructiveUsed: 0,
            writeBudgetTotal: 50,
            writesUsed: 0,
            expiresAt: stale,
            renewalsUsed: 0,
          },
        },
      },
      now,
    );
    expect(Object.keys(pruned.sessions)).toEqual(["fresh"]);
  });
});

// ---------------------------------------------------------------------------
// SessionRegistry — TTL math + budget counters + persistence
// ---------------------------------------------------------------------------

describe("SessionRegistry", () => {
  function makeRegistry(clock: FakeClock): SessionRegistry {
    return new SessionRegistry(tmpDir, newSessionIdFactory(), () => clock.now());
  }

  it("starts inactive and returns null from snapshot()", () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    expect(reg.snapshot()).toBeNull();
    expect(reg.isExpired()).toBe(false);
    expect(reg.secondsRemaining()).toBe(0);
  });

  it("start() activates a session with §5.2.1 defaults and persists the destructive counter", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);

    const snap = await reg.start(
      {
        projectId: "01JPROJECT00000000000000001",
        userOid: "00000000-0000-0000-0000-0000a3f2c891",
        clientSlug: "claude-desktop",
        folderPath: "/Project Foo",
        authoritativeFileName: "spec.md",
      },
      testSignal(),
    );

    expect(snap.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
    expect(snap.writeBudgetTotal).toBe(DEFAULT_WRITE_BUDGET);
    expect(snap.destructiveBudgetTotal).toBe(DEFAULT_DESTRUCTIVE_BUDGET);
    expect(snap.writesUsed).toBe(0);
    expect(snap.destructiveUsed).toBe(0);
    expect(snap.renewalsUsed).toBe(0);
    expect(snap.sourceCounters).toEqual({ chat: 0, project: 0, external: 0 });
    expect(snap.agentId).toMatch(/^00000000-claude-desktop-01jtest0/);
    // expiresAt = startedAt + ttl
    expect(Date.parse(snap.expiresAt) - Date.parse(snap.startedAt)).toBe(
      DEFAULT_TTL_SECONDS * 1000,
    );

    // Persisted file matches the in-memory snapshot.
    const file = await loadDestructiveCounts(tmpDir, clock.now(), testSignal());
    expect(file.sessions[snap.sessionId]).toMatchObject({
      projectId: snap.projectId,
      destructiveBudgetTotal: DEFAULT_DESTRUCTIVE_BUDGET,
      destructiveUsed: 0,
      writeBudgetTotal: DEFAULT_WRITE_BUDGET,
      writesUsed: 0,
    });
  });

  it("snapshot() returns a defensive clone — mutations do not leak back", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    await reg.start(
      {
        projectId: "p1",
        userOid: "oid-1",
        clientSlug: "vscode",
        folderPath: "/x",
        authoritativeFileName: "y.md",
      },
      testSignal(),
    );
    const snap = reg.snapshot();
    if (snap === null) throw new Error("expected snapshot");
    snap.writesUsed = 9999;
    snap.sourceCounters.chat = 9999;
    const fresh = reg.snapshot();
    expect(fresh?.writesUsed).toBe(0);
    expect(fresh?.sourceCounters.chat).toBe(0);
  });

  it("clamps TTL into the §5.2.1 [15min, 8h] range", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    const snap = await reg.start(
      {
        projectId: "p",
        userOid: "o",
        clientSlug: "x",
        folderPath: "/x",
        authoritativeFileName: "a.md",
        ttlSeconds: 1, // way below MIN
      },
      testSignal(),
    );
    expect(snap.ttlSeconds).toBe(MIN_TTL_SECONDS);
    await reg.end(testSignal());
    const reg2 = makeRegistry(clock);
    const snap2 = await reg2.start(
      {
        projectId: "p",
        userOid: "o",
        clientSlug: "x",
        folderPath: "/x",
        authoritativeFileName: "a.md",
        ttlSeconds: 1_000_000, // way above MAX
      },
      testSignal(),
    );
    expect(snap2.ttlSeconds).toBe(MAX_TTL_SECONDS);
  });

  it("clamps destructive budget at the §5.2.1 hard cap (50)", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    const snap = await reg.start(
      {
        projectId: "p",
        userOid: "o",
        clientSlug: "x",
        folderPath: "/x",
        authoritativeFileName: "a.md",
        destructiveBudget: 9999,
      },
      testSignal(),
    );
    expect(snap.destructiveBudgetTotal).toBe(MAX_DESTRUCTIVE_BUDGET);
  });

  it("refuses a second start() while a session is active", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    await reg.start(
      {
        projectId: "p1",
        userOid: "o",
        clientSlug: "x",
        folderPath: "/x",
        authoritativeFileName: "a.md",
      },
      testSignal(),
    );
    await expect(
      reg.start(
        {
          projectId: "p2",
          userOid: "o",
          clientSlug: "x",
          folderPath: "/y",
          authoritativeFileName: "b.md",
        },
        testSignal(),
      ),
    ).rejects.toBeInstanceOf(SessionAlreadyActiveError);
  });

  it("isExpired() reflects the clock crossing expiresAt", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    await reg.start(
      {
        projectId: "p",
        userOid: "o",
        clientSlug: "x",
        folderPath: "/x",
        authoritativeFileName: "a.md",
        ttlSeconds: 60 * 60,
      },
      testSignal(),
    );
    expect(reg.isExpired()).toBe(false);
    expect(reg.secondsRemaining()).toBe(60 * 60);

    clock.advanceSeconds(30 * 60);
    expect(reg.isExpired()).toBe(false);
    expect(reg.secondsRemaining()).toBe(30 * 60);

    clock.advanceSeconds(31 * 60);
    expect(reg.isExpired()).toBe(true);
    expect(reg.secondsRemaining()).toBe(0);
  });

  it("incrementWrites / incrementDestructive / incrementSource flush to disk", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    const start = await reg.start(
      {
        projectId: "p",
        userOid: "o",
        clientSlug: "x",
        folderPath: "/x",
        authoritativeFileName: "a.md",
      },
      testSignal(),
    );
    await reg.incrementWrites(testSignal());
    await reg.incrementWrites(testSignal());
    await reg.incrementDestructive(testSignal());
    await reg.incrementSource("external", testSignal());

    const snap = reg.snapshot();
    expect(snap?.writesUsed).toBe(2);
    expect(snap?.destructiveUsed).toBe(1);
    expect(snap?.sourceCounters.external).toBe(1);

    const file = await loadDestructiveCounts(tmpDir, clock.now(), testSignal());
    expect(file.sessions[start.sessionId]).toMatchObject({
      writesUsed: 2,
      destructiveUsed: 1,
    });
  });

  it("renew() resets expiresAt and bumps renewalsUsed", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    await reg.start(
      {
        projectId: "p",
        userOid: "o",
        clientSlug: "x",
        folderPath: "/x",
        authoritativeFileName: "a.md",
        ttlSeconds: 60 * 60,
      },
      testSignal(),
    );
    clock.advanceSeconds(45 * 60); // 45 min in
    const snap = await reg.renew(undefined, testSignal());
    expect(snap.renewalsUsed).toBe(1);
    expect(reg.secondsRemaining()).toBe(60 * 60);
  });

  it("end() clears the in-memory session and removes the persisted entry", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    const start = await reg.start(
      {
        projectId: "p",
        userOid: "o",
        clientSlug: "x",
        folderPath: "/x",
        authoritativeFileName: "a.md",
      },
      testSignal(),
    );
    await reg.end(testSignal());
    expect(reg.snapshot()).toBeNull();
    const file = await loadDestructiveCounts(tmpDir, clock.now(), testSignal());
    expect(file.sessions[start.sessionId]).toBeUndefined();
  });

  it("counter mutations throw NoActiveSessionError when no session is active", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const reg = makeRegistry(clock);
    await expect(reg.incrementWrites(testSignal())).rejects.toBeInstanceOf(NoActiveSessionError);
    await expect(reg.incrementDestructive(testSignal())).rejects.toBeInstanceOf(
      NoActiveSessionError,
    );
    await expect(reg.incrementRenewals(testSignal())).rejects.toBeInstanceOf(NoActiveSessionError);
    await expect(reg.incrementSource("chat", testSignal())).rejects.toBeInstanceOf(
      NoActiveSessionError,
    );
    await expect(reg.renew(undefined, testSignal())).rejects.toBeInstanceOf(NoActiveSessionError);
  });
});
