// Unit tests for the collab v1 local-metadata + recents codec.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ProjectMetadataParseError,
  ProjectMetadataSchema,
  RecentsFileSchema,
  loadProjectMetadata,
  loadRecents,
  projectMetadataPath,
  recentsPath,
  saveProjectMetadata,
  upsertRecent,
  type ProjectMetadata,
  type RecentEntry,
} from "../../src/collab/projects.js";
import { testSignal } from "../helpers.js";

let dir: string;

const sampleMetadata = (overrides: Partial<ProjectMetadata> = {}): ProjectMetadata => ({
  schemaVersion: 1,
  projectId: "01JABCDE0FGHJKMNPQRSTV0WXY",
  folderId: "01FOLDER",
  folderPath: "/Documents/Project Foo",
  driveId: "drive-1",
  pinnedAuthoritativeFileId: "01AUTH",
  pinnedSentinelFirstSeenAt: "2026-04-19T05:00:00Z",
  pinnedAtFirstSeenCTag: '"c:{sentinel-1},1"',
  displayAuthoritativeFileName: "spec.md",
  docId: null,
  addedAt: "2026-04-19T05:00:00Z",
  lastSeenSentinelAt: "2026-04-19T05:00:00Z",
  lastSeenAuthoritativeCTag: null,
  lastSeenAuthoritativeRevision: null,
  perAgent: {},
  ...overrides,
});

const sampleRecent = (overrides: Partial<RecentEntry> = {}): RecentEntry => ({
  projectId: "01JABCDE0FGHJKMNPQRSTV0WXY",
  folderId: "01FOLDER",
  folderPath: "/Documents/Project Foo",
  authoritativeFile: "spec.md",
  lastOpened: "2026-04-19T05:00:00Z",
  role: "originator",
  available: true,
  unavailableReason: null,
  ...overrides,
});

describe("collab/projects", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "graphdo-projects-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("project metadata", () => {
    it("round-trips through Zod and atomic write", async () => {
      const meta = sampleMetadata();
      await saveProjectMetadata(dir, meta, testSignal());
      const loaded = await loadProjectMetadata(dir, meta.projectId, testSignal());
      expect(loaded).toEqual(meta);
    });

    it("returns null when the metadata file does not exist", async () => {
      const loaded = await loadProjectMetadata(dir, "01JM1SS1NG0FGHJKMNPQRSTV0X", testSignal());
      expect(loaded).toBeNull();
    });

    it("rejects unknown top-level keys (strict schema)", () => {
      const result = ProjectMetadataSchema.safeParse({
        ...sampleMetadata(),
        unknownField: "x",
      });
      expect(result.success).toBe(false);
    });

    it("requires the schemaVersion literal", () => {
      const result = ProjectMetadataSchema.safeParse({ ...sampleMetadata(), schemaVersion: 2 });
      expect(result.success).toBe(false);
    });

    it("throws ProjectMetadataParseError when the file is corrupt JSON", async () => {
      const meta = sampleMetadata();
      const target = projectMetadataPath(dir, meta.projectId);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "{not json", "utf-8");
      await expect(loadProjectMetadata(dir, meta.projectId, testSignal())).rejects.toBeInstanceOf(
        ProjectMetadataParseError,
      );
    });

    it("throws ProjectMetadataParseError when the file fails Zod validation", async () => {
      const meta = sampleMetadata();
      const target = projectMetadataPath(dir, meta.projectId);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify({ schemaVersion: 1 }), "utf-8");
      await expect(loadProjectMetadata(dir, meta.projectId, testSignal())).rejects.toBeInstanceOf(
        ProjectMetadataParseError,
      );
    });
  });

  describe("recents", () => {
    it("returns an empty file when missing", async () => {
      const recents = await loadRecents(dir, testSignal());
      expect(recents).toEqual({ schemaVersion: 1, entries: [] });
    });

    it("upserts a new entry to the head", async () => {
      const e1 = sampleRecent({ projectId: "P1" });
      const e2 = sampleRecent({ projectId: "P2", lastOpened: "2026-04-19T06:00:00Z" });
      await upsertRecent(dir, e1, testSignal());
      const after = await upsertRecent(dir, e2, testSignal());
      expect(after.entries.map((e) => e.projectId)).toEqual(["P2", "P1"]);

      const loaded = await loadRecents(dir, testSignal());
      expect(loaded).toEqual(after);
    });

    it("replaces an existing entry without duplicating it", async () => {
      const original = sampleRecent({ projectId: "P1", folderPath: "/Old/Path" });
      const updated = sampleRecent({ projectId: "P1", folderPath: "/New/Path" });
      await upsertRecent(dir, original, testSignal());
      const after = await upsertRecent(dir, updated, testSignal());
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0]?.folderPath).toBe("/New/Path");
    });

    it("preserves stale (available=false) entries", async () => {
      await upsertRecent(
        dir,
        sampleRecent({ projectId: "P1", available: false, unavailableReason: "folder gone" }),
        testSignal(),
      );
      await upsertRecent(dir, sampleRecent({ projectId: "P2" }), testSignal());
      const loaded = await loadRecents(dir, testSignal());
      const p1 = loaded.entries.find((e) => e.projectId === "P1");
      expect(p1?.available).toBe(false);
      expect(p1?.unavailableReason).toBe("folder gone");
    });

    it("rejects unknown keys at the top level (strict schema)", () => {
      const result = RecentsFileSchema.safeParse({
        schemaVersion: 1,
        entries: [],
        somethingElse: 1,
      });
      expect(result.success).toBe(false);
    });
  });

  it("metadata and recents land in <configDir>/projects/", () => {
    const projectId = "01JABCDE0FGHJKMNPQRSTV0WXY";
    const meta = projectMetadataPath(dir, projectId);
    const rec = recentsPath(dir);
    expect(meta).toBe(path.join(dir, "projects", `${projectId}.json`));
    expect(rec).toBe(path.join(dir, "projects", "recent.json"));
  });

  it("projectMetadataPath rejects non-ULID projectId (path-injection guard)", () => {
    expect(() => projectMetadataPath(dir, "abc")).toThrow(/ULID/);
    expect(() => projectMetadataPath(dir, "../../etc/foo")).toThrow(/ULID/);
    // 26 chars but contains invalid Crockford-base32 letters (I, L, O, U)
    expect(() => projectMetadataPath(dir, "01JABCDEILOU0FGHJKMNPQRST0")).toThrow(/ULID/);
  });

  it("the on-disk JSON pretty-prints with two spaces and a trailing newline", async () => {
    const meta = sampleMetadata();
    await saveProjectMetadata(dir, meta, testSignal());
    const raw = await readFile(projectMetadataPath(dir, meta.projectId), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "schemaVersion": 1');
  });
});
