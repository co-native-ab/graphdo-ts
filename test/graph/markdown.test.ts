// Graph-layer tests for OneDrive-backed markdown operations.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTestEnv, gid, testSignal, type TestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import {
  MAX_DIRECT_CONTENT_BYTES,
  MarkdownCTagMismatchError,
  MarkdownFileAlreadyExistsError,
  MarkdownFileTooLargeError,
  MarkdownFolderEntryKind,
  MarkdownUnknownVersionError,
  buildMarkdownPreviewUrl,
  createMarkdownFile,
  deleteDriveItem,
  downloadDriveItemVersionContent,
  downloadMarkdownContent,
  findMarkdownFileByName,
  getDriveItem,
  getMyDrive,
  getRevisionContent,
  listDriveItemVersions,
  listMarkdownFiles,
  listMarkdownFolderEntries,
  listRootFolders,
  resolveCurrentRevision,
  updateMarkdownFile,
} from "../../src/graph/markdown.js";

function seedOneDrive(env: TestEnv): void {
  env.state.driveRootChildren = [
    {
      id: "folder-1",
      name: "Notes",
      folder: { childCount: 2 },
      lastModifiedDateTime: "2026-04-10T10:00:00Z",
    },
    {
      id: "folder-2",
      name: "Work",
      folder: { childCount: 0 },
      lastModifiedDateTime: "2026-04-11T11:00:00Z",
    },
    // Graph can also return files at the root level — these must be excluded
    // from the folder picker.
    {
      id: "stray-file",
      name: "stray.txt",
      file: { mimeType: "text/plain" },
      size: 10,
    },
  ];
  env.state.driveFolderChildren.set("folder-1", [
    {
      id: "file-md-1",
      name: "ideas.md",
      size: 12,
      lastModifiedDateTime: "2026-04-10T10:30:00Z",
      file: { mimeType: "text/markdown" },
      content: "hello world!",
    },
    {
      id: "file-md-2",
      name: "Notes.MD",
      size: 4,
      lastModifiedDateTime: "2026-04-10T10:35:00Z",
      file: { mimeType: "text/markdown" },
      content: "body",
    },
    {
      id: "file-txt",
      name: "readme.txt",
      size: 5,
      lastModifiedDateTime: "2026-04-10T10:40:00Z",
      file: { mimeType: "text/plain" },
      content: "plain",
    },
  ]);
  env.state.driveFolderChildren.set("folder-2", []);
}

describe("markdown graph operations", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    seedOneDrive(env);
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("listRootFolders returns only folders", async () => {
    const folders = await listRootFolders(client, testSignal());
    expect(folders.map((f) => f.id)).toEqual(["folder-1", "folder-2"]);
    expect(folders.every((f) => f.folder !== undefined)).toBe(true);
  });

  it("listMarkdownFiles filters to .md files, case-insensitive", async () => {
    const files = await listMarkdownFiles(client, gid("folder-1"), testSignal());
    expect(files.map((f) => f.name).sort()).toEqual(["Notes.MD", "ideas.md"]);
  });

  it("listMarkdownFiles returns empty array when folder has no markdown files", async () => {
    const files = await listMarkdownFiles(client, gid("folder-2"), testSignal());
    expect(files).toEqual([]);
  });

  it("findMarkdownFileByName matches case-insensitively", async () => {
    const a = await findMarkdownFileByName(client, gid("folder-1"), "IDEAS.md", testSignal());
    expect(a?.id).toBe("file-md-1");
    const b = await findMarkdownFileByName(client, gid("folder-1"), "notes.md", testSignal());
    expect(b?.id).toBe("file-md-2");
  });

  it("findMarkdownFileByName returns null for unknown file", async () => {
    const result = await findMarkdownFileByName(
      client,
      gid("folder-1"),
      "missing.md",
      testSignal(),
    );
    expect(result).toBeNull();
  });

  it("getDriveItem returns metadata", async () => {
    const item = await getDriveItem(client, gid("file-md-1"), testSignal());
    expect(item.name).toBe("ideas.md");
    expect(item.size).toBe(12);
  });

  it("downloadMarkdownContent returns UTF-8 body", async () => {
    const body = await downloadMarkdownContent(client, gid("file-md-1"), testSignal());
    expect(body).toBe("hello world!");
  });

  it("downloadMarkdownContent throws MarkdownFileTooLargeError when size exceeds limit", async () => {
    const existing = env.state.driveFolderChildren.get("folder-1") ?? [];
    existing.push({
      id: "huge",
      name: "huge.md",
      size: MAX_DIRECT_CONTENT_BYTES + 1,
      file: { mimeType: "text/markdown" },
      content: "x",
    });
    env.state.driveFolderChildren.set("folder-1", existing);

    await expect(downloadMarkdownContent(client, gid("huge"), testSignal())).rejects.toBeInstanceOf(
      MarkdownFileTooLargeError,
    );
  });

  it("downloadMarkdownContent allows a file whose reported size equals MAX_DIRECT_CONTENT_BYTES (boundary)", async () => {
    const exact = "a".repeat(MAX_DIRECT_CONTENT_BYTES);
    const existing = env.state.driveFolderChildren.get("folder-1") ?? [];
    existing.push({
      id: "exact-4mb",
      name: "exact.md",
      size: MAX_DIRECT_CONTENT_BYTES,
      file: { mimeType: "text/markdown" },
      content: exact,
    });
    env.state.driveFolderChildren.set("folder-1", existing);

    const body = await downloadMarkdownContent(client, gid("exact-4mb"), testSignal());
    expect(body.length).toBe(MAX_DIRECT_CONTENT_BYTES);
  });

  it("uploadMarkdownContent removed; createMarkdownFile and updateMarkdownFile are the supported API", async () => {
    // Sanity check that the new API is wired up (replaces the legacy upload tests).
    const created = await createMarkdownFile(
      client,
      gid("folder-2"),
      "fresh.md",
      "# Fresh\n",
      testSignal(),
    );
    expect(created.name).toBe("fresh.md");
    expect(created.cTag).toMatch(/^"c:\{.*\},\d+"$/);
  });

  it("createMarkdownFile creates a brand-new file and returns a cTag", async () => {
    const item = await createMarkdownFile(
      client,
      gid("folder-1"),
      "new-note.md",
      "# Hello\n",
      testSignal(),
    );
    expect(item.name).toBe("new-note.md");
    expect(item.cTag).toBeTruthy();

    const files = await listMarkdownFiles(client, gid("folder-1"), testSignal());
    expect(files.map((f) => f.name)).toContain("new-note.md");

    const stored = await downloadMarkdownContent(client, gid(item.id), testSignal());
    expect(stored).toBe("# Hello\n");
  });

  it("createMarkdownFile rejects payloads over 4 MiB without hitting the network", async () => {
    const oversized = "a".repeat(1024 * 1024).repeat(5); // 5 MiB
    await expect(
      createMarkdownFile(client, gid("folder-1"), "big.md", oversized, testSignal()),
    ).rejects.toBeInstanceOf(MarkdownFileTooLargeError);
  });

  it("createMarkdownFile accepts a payload of exactly MAX_DIRECT_CONTENT_BYTES (boundary)", async () => {
    // The comparison must be `>` (not `>=`): exactly 4 MiB is allowed.
    // Verified live against real OneDrive — Graph accepts simple PUT at 4 MiB.
    const exact = "a".repeat(MAX_DIRECT_CONTENT_BYTES);
    const item = await createMarkdownFile(
      client,
      gid("folder-1"),
      "exact-4mb.md",
      exact,
      testSignal(),
    );
    expect(item.size).toBe(MAX_DIRECT_CONTENT_BYTES);
  });

  it("createMarkdownFile rejects a payload of MAX_DIRECT_CONTENT_BYTES + 1 (boundary)", async () => {
    const overByOne = "a".repeat(MAX_DIRECT_CONTENT_BYTES + 1);
    await expect(
      createMarkdownFile(client, gid("folder-1"), "over-by-one.md", overByOne, testSignal()),
    ).rejects.toBeInstanceOf(MarkdownFileTooLargeError);
  });

  it("createMarkdownFile throws MarkdownFileAlreadyExistsError when the name is taken", async () => {
    await expect(
      createMarkdownFile(client, gid("folder-1"), "ideas.md", "x", testSignal()),
    ).rejects.toBeInstanceOf(MarkdownFileAlreadyExistsError);

    // The existing file's content was NOT changed.
    const body = await downloadMarkdownContent(client, gid("file-md-1"), testSignal());
    expect(body).toBe("hello world!");
  });

  it("updateMarkdownFile overwrites with matching cTag and bumps the cTag", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    const beforeCTag = before.cTag;
    expect(beforeCTag).toBeTruthy();

    const updated = await updateMarkdownFile(
      client,
      gid("file-md-1"),
      beforeCTag!,
      "updated content",
      testSignal(),
    );
    expect(updated.id).toBe("file-md-1");
    expect(updated.cTag).toBeTruthy();
    expect(updated.cTag).not.toBe(beforeCTag);

    const body = await downloadMarkdownContent(client, gid("file-md-1"), testSignal());
    expect(body).toBe("updated content");
  });

  it("updateMarkdownFile throws MarkdownCTagMismatchError when the supplied cTag is stale", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    // First update bumps the cTag.
    await updateMarkdownFile(client, gid("file-md-1"), before.cTag!, "v2", testSignal());

    // Second update with the now-stale cTag must fail with the typed error.
    await expect(
      updateMarkdownFile(client, gid("file-md-1"), before.cTag!, "v3", testSignal()),
    ).rejects.toBeInstanceOf(MarkdownCTagMismatchError);

    // Content was NOT changed by the failed update.
    const body = await downloadMarkdownContent(client, gid("file-md-1"), testSignal());
    expect(body).toBe("v2");
  });

  it("updateMarkdownFile cTag-mismatch error carries the current item with the new cTag", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    await updateMarkdownFile(client, gid("file-md-1"), before.cTag!, "v2", testSignal());

    try {
      await updateMarkdownFile(client, gid("file-md-1"), before.cTag!, "v3", testSignal());
      throw new Error("expected MarkdownCTagMismatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(MarkdownCTagMismatchError);
      const e = err as MarkdownCTagMismatchError;
      expect(e.suppliedCTag).toBe(before.cTag);
      expect(e.currentItem.id).toBe("file-md-1");
      expect(e.currentItem.cTag).toBeTruthy();
      expect(e.currentItem.cTag).not.toBe(before.cTag);
    }
  });

  it("updateMarkdownFile rejects empty cTag", async () => {
    await expect(
      updateMarkdownFile(client, gid("file-md-1"), "", "x", testSignal()),
    ).rejects.toThrow("cTag must not be empty");
  });

  it("updateMarkdownFile rejects payloads over 4 MiB without hitting the network", async () => {
    const oversized = "a".repeat(1024 * 1024).repeat(5);
    await expect(
      updateMarkdownFile(client, gid("file-md-1"), "any-cTag", oversized, testSignal()),
    ).rejects.toBeInstanceOf(MarkdownFileTooLargeError);
  });

  it("updateMarkdownFile accepts a payload of exactly MAX_DIRECT_CONTENT_BYTES (boundary)", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    const exact = "a".repeat(MAX_DIRECT_CONTENT_BYTES);
    const updated = await updateMarkdownFile(
      client,
      gid("file-md-1"),
      before.cTag!,
      exact,
      testSignal(),
    );
    expect(updated.size).toBe(MAX_DIRECT_CONTENT_BYTES);
  });

  it("updateMarkdownFile rejects a payload of MAX_DIRECT_CONTENT_BYTES + 1 (boundary)", async () => {
    const overByOne = "a".repeat(MAX_DIRECT_CONTENT_BYTES + 1);
    await expect(
      updateMarkdownFile(client, gid("file-md-1"), "any-cTag", overByOne, testSignal()),
    ).rejects.toBeInstanceOf(MarkdownFileTooLargeError);
  });

  it("deleteDriveItem removes the file", async () => {
    await deleteDriveItem(client, gid("file-md-1"), testSignal());
    const files = await listMarkdownFiles(client, gid("folder-1"), testSignal());
    expect(files.map((f) => f.id)).not.toContain("file-md-1");
  });
});

// ---------------------------------------------------------------------------
// Classification (listMarkdownFolderEntries) + strict naming enforcement
// ---------------------------------------------------------------------------

describe("markdown graph operations: classification & validation", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    env.state.driveRootChildren = [{ id: "folder-1", name: "Notes", folder: { childCount: 0 } }];
    env.state.driveFolderChildren.set("folder-1", [
      // Supported: plain .md file with a safe name
      {
        id: "ok-1",
        name: "plain.md",
        size: 4,
        file: { mimeType: "text/markdown" },
        content: "body",
      },
      // Unsupported: subdirectory
      {
        id: "subdir-1",
        name: "archive",
        folder: { childCount: 0 },
      },
      // Unsupported: .md file with a name containing a character not in the allow-list
      {
        id: "weird-1",
        name: "weird@name.md",
        size: 3,
        file: { mimeType: "text/markdown" },
        content: "weird",
      },
      // Unsupported: .md file with the Windows reserved stem
      {
        id: "reserved-1",
        name: "CON.md",
        size: 3,
        file: { mimeType: "text/markdown" },
        content: "reserved",
      },
      // Excluded from listing entirely: non-.md file
      {
        id: "txt-1",
        name: "plain.txt",
        size: 5,
        file: { mimeType: "text/plain" },
        content: "plain",
      },
    ]);
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("listMarkdownFolderEntries classifies supported .md files", async () => {
    const entries = await listMarkdownFolderEntries(client, gid("folder-1"), testSignal());
    const supported = entries.filter((e) => e.kind === MarkdownFolderEntryKind.Supported);
    expect(supported.map((e) => e.item.id)).toEqual(["ok-1"]);
  });

  it("listMarkdownFolderEntries flags subdirectories as unsupported", async () => {
    const entries = await listMarkdownFolderEntries(client, gid("folder-1"), testSignal());
    const subdir = entries.find((e) => e.item.id === "subdir-1");
    expect(subdir).toBeDefined();
    expect(subdir!.kind).toBe(MarkdownFolderEntryKind.Unsupported);
    if (subdir!.kind === MarkdownFolderEntryKind.Unsupported) {
      expect(subdir!.reason).toContain("subdirectory");
    }
  });

  it("listMarkdownFolderEntries flags .md files with unsupported names", async () => {
    const entries = await listMarkdownFolderEntries(client, gid("folder-1"), testSignal());
    const weird = entries.find((e) => e.item.id === "weird-1");
    expect(weird?.kind).toBe(MarkdownFolderEntryKind.Unsupported);
    if (weird?.kind === MarkdownFolderEntryKind.Unsupported) {
      expect(weird.reason).toContain("unsupported file name");
    }
    const reserved = entries.find((e) => e.item.id === "reserved-1");
    expect(reserved?.kind).toBe(MarkdownFolderEntryKind.Unsupported);
    if (reserved?.kind === MarkdownFolderEntryKind.Unsupported) {
      expect(reserved.reason).toContain("reserved");
    }
  });

  it("listMarkdownFolderEntries omits non-markdown files entirely", async () => {
    const entries = await listMarkdownFolderEntries(client, gid("folder-1"), testSignal());
    expect(entries.some((e) => e.item.id === "txt-1")).toBe(false);
  });

  it("listMarkdownFiles returns only supported entries", async () => {
    const files = await listMarkdownFiles(client, gid("folder-1"), testSignal());
    expect(files.map((f) => f.id)).toEqual(["ok-1"]);
  });

  it("findMarkdownFileByName rejects invalid names before touching the network", async () => {
    await expect(
      findMarkdownFileByName(client, gid("folder-1"), "../escape.md", testSignal()),
    ).rejects.toThrow(/path separator/);
  });

  it("findMarkdownFileByName returns null for a valid-but-missing name", async () => {
    const result = await findMarkdownFileByName(
      client,
      gid("folder-1"),
      "missing.md",
      testSignal(),
    );
    expect(result).toBeNull();
  });

  it("findMarkdownFileByName does not match a file whose remote name is unsupported", async () => {
    // Even though "weird@name.md" exists remotely, it should not be reachable
    // by name-based lookup because listMarkdownFiles filters it out.
    const result = await findMarkdownFileByName(client, gid("folder-1"), "notes.md", testSignal());
    expect(result).toBeNull();
  });

  it("createMarkdownFile rejects unsafe names before touching the network", async () => {
    await expect(
      createMarkdownFile(client, gid("folder-1"), "sub/dir.md", "x", testSignal()),
    ).rejects.toThrow(/path separator/);
    await expect(
      createMarkdownFile(client, gid("folder-1"), "CON.md", "x", testSignal()),
    ).rejects.toThrow(/reserved name/);
    await expect(
      createMarkdownFile(client, gid("folder-1"), "weird@name.md", "x", testSignal()),
    ).rejects.toThrow(/not portable/);
  });
});

// ---------------------------------------------------------------------------
// getMyDrive — GET /me/drive
// ---------------------------------------------------------------------------

describe("getMyDrive", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    client = new GraphClient(env.graphUrl, { getToken: () => Promise.resolve("test-token") });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("returns drive id, driveType, and webUrl from the mock", async () => {
    env.state.drive = {
      id: "drive-123",
      driveType: "business",
      webUrl: "https://contoso-my.sharepoint.com/personal/user/Documents",
    };
    const drive = await getMyDrive(client, testSignal());
    expect(drive.id).toBe("drive-123");
    expect(drive.driveType).toBe("business");
    expect(drive.webUrl).toBe("https://contoso-my.sharepoint.com/personal/user/Documents");
  });

  it("tolerates a drive response with no webUrl", async () => {
    env.state.drive = { id: "drive-456", driveType: "personal", webUrl: "" };
    const drive = await getMyDrive(client, testSignal());
    expect(drive.id).toBe("drive-456");
    // Empty string is a string — the schema accepts it; the tool layer treats
    // empty as "no URL" and falls back to the default.
    expect(drive.webUrl).toBe("");
  });
});

describe("markdown version history graph operations", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    seedOneDrive(env);
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("listDriveItemVersions returns only the current version for a file with no prior writes", async () => {
    // Real OneDrive includes the current version as the first (and only) entry
    // when the file has never been overwritten.
    const versions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    expect(versions).toHaveLength(1);
    expect(versions[0]?.id).toBeTruthy();
  });

  it("overwriting a file via updateMarkdownFile snapshots the prior version", async () => {
    const start = await getDriveItem(client, gid("file-md-1"), testSignal());
    const after1 = await updateMarkdownFile(
      client,
      gid("file-md-1"),
      start.cTag!,
      "v2",
      testSignal(),
    );
    await updateMarkdownFile(client, gid("file-md-1"), after1.cTag!, "v3", testSignal());

    const versions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    // Current version + two historical snapshots (the original + v2).
    expect(versions).toHaveLength(3);
    // Every version carries a non-empty ID and a timestamp.
    for (const v of versions) {
      expect(v.id.length).toBeGreaterThan(0);
      expect(typeof v.lastModifiedDateTime).toBe("string");
    }
    // versions[0] is the current version (not downloadable via the versions endpoint).
    // versions[1] should be v2 — the snapshot created by the second overwrite.
    const priorVersion = versions[1];
    if (!priorVersion) throw new Error("expected at least two versions");
    const priorContent = await downloadDriveItemVersionContent(
      client,
      gid("file-md-1"),
      gid(priorVersion.id),
      testSignal(),
    );
    expect(["v2", "hello world!"]).toContain(priorContent);
  });

  it("downloadDriveItemVersionContent returns the stored content", async () => {
    const start = await getDriveItem(client, gid("file-md-1"), testSignal());
    await updateMarkdownFile(client, gid("file-md-1"), start.cTag!, "updated", testSignal());
    const versions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    // versions[0] is the current version; versions[1] is the prior snapshot.
    expect(versions).toHaveLength(2);
    const prior = versions[1];
    if (!prior) throw new Error("expected prior version");
    const content = await downloadDriveItemVersionContent(
      client,
      gid("file-md-1"),
      gid(prior.id),
      testSignal(),
    );
    expect(content).toBe("hello world!");
  });

  it("downloadDriveItemVersionContent returns a 404-style error for an unknown versionId", async () => {
    await expect(
      downloadDriveItemVersionContent(
        client,
        gid("file-md-1"),
        gid("does-not-exist"),
        testSignal(),
      ),
    ).rejects.toThrow();
  });

  // Note: the previous "rejects empty itemId" / "rejects empty versionId"
  // tests have moved to `test/graph/ids.test.ts` — per ADR-0005 these
  // calls are now compile-time errors at every helper boundary.
});

// ---------------------------------------------------------------------------
// Current revision surfacing + getRevisionContent
// ---------------------------------------------------------------------------

describe("markdown current revision tracking", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    seedOneDrive(env);
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("getDriveItem omits `version` (mirrors real OneDrive, which commonly does not include it)", async () => {
    const item = await getDriveItem(client, gid("file-md-1"), testSignal());
    expect(item.version).toBeUndefined();
  });

  it("createMarkdownFile omits `version` on the returned drive item", async () => {
    const created = await createMarkdownFile(
      client,
      gid("folder-2"),
      "fresh.md",
      "one",
      testSignal(),
    );
    expect(created.version).toBeUndefined();
  });

  it("updateMarkdownFile omits `version` on the returned drive item", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    const after = await updateMarkdownFile(
      client,
      gid("file-md-1"),
      before.cTag!,
      "v1",
      testSignal(),
    );
    expect(after.version).toBeUndefined();
  });

  it("/versions surfaces a stable, monotonically-bumping current revision id even though the drive item omits `version`", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    const beforeVersions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    const v0 = beforeVersions[0]?.id;
    expect(v0).toBeTruthy();

    const after1 = await updateMarkdownFile(
      client,
      gid("file-md-1"),
      before.cTag!,
      "v1",
      testSignal(),
    );
    const v1Versions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    const v1 = v1Versions[0]?.id;
    expect(v1).toBeTruthy();
    expect(v1).not.toBe(v0);

    const after2 = await updateMarkdownFile(
      client,
      gid("file-md-1"),
      after1.cTag!,
      "v2",
      testSignal(),
    );
    void after2;
    const v2Versions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    expect(v2Versions[0]?.id).not.toBe(v1);
  });

  it("prior revision ID surfaces as a history entry after an update", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    const beforeVersions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    const priorRevision = beforeVersions[0]?.id;
    expect(priorRevision).toBeTruthy();

    await updateMarkdownFile(client, gid("file-md-1"), before.cTag!, "v1", testSignal());
    const history = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    // The first overwrite promotes the prior current revision into history.
    expect(history.map((v) => v.id)).toContain(priorRevision);
  });
});

describe("resolveCurrentRevision", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    seedOneDrive(env);
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("returns item.version verbatim when present (no /versions call needed)", async () => {
    // The mock omits `version` on driveItem responses, so synthesise one
    // here to exercise the fast path: when Graph DOES populate `version`,
    // the resolver must return it without consulting /versions.
    const item = await getDriveItem(client, gid("file-md-1"), testSignal());
    const itemWithVersion = { ...item, version: "synthetic-rev" };
    const resolved = await resolveCurrentRevision(client, itemWithVersion, testSignal());
    expect(resolved).toBe("synthetic-rev");
  });

  it("falls back to the newest /versions entry when item.version is absent (the production-typical case)", async () => {
    const item = await getDriveItem(client, gid("file-md-1"), testSignal());
    // The mock already mirrors real Graph and omits `version` on the item,
    // so no synthetic stripping is needed.
    expect(item.version).toBeUndefined();
    const history = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    const expected = history[0]?.id;
    expect(expected).toBeTruthy();

    const resolved = await resolveCurrentRevision(client, item, testSignal());
    expect(resolved).toBe(expected);
  });

  it("returns undefined when item.version is absent and /versions yields nothing", async () => {
    // Test the case where an item exists but has no version history entries.
    env.state.driveItemVersions.set("ghost-item", []);
    const ghost = {
      id: "ghost-item",
      name: "ghost.md",
      file: { mimeType: "text/markdown" },
    };
    const resolved = await resolveCurrentRevision(client, ghost, testSignal());
    expect(resolved).toBeUndefined();
  });

  it("returns undefined (does not throw) when /versions errors out", async () => {
    // Test that /versions errors are swallowed and return undefined rather
    // than failing the primary operation.
    const ghost = {
      id: "definitely-not-a-real-item-id",
      name: "ghost.md",
      file: { mimeType: "text/markdown" },
    };
    const resolved = await resolveCurrentRevision(client, ghost, testSignal());
    expect(resolved).toBeUndefined();
  });
});

describe("getRevisionContent", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    seedOneDrive(env);
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("returns live content when the revision id is the current one (taken from /versions, since item.version is omitted by Graph)", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    await updateMarkdownFile(client, gid("file-md-1"), before.cTag!, "current-body", testSignal());
    const current = await getDriveItem(client, gid("file-md-1"), testSignal());
    // The mock omits `version` on the drive item to mirror real Graph; the
    // current version ID must come from the /versions list.
    const history = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    const currentVersionId = history[0]?.id;
    if (!currentVersionId) throw new Error("expected at least one version in the list");
    const body = await getRevisionContent(client, current, gid(currentVersionId), testSignal());
    expect(body).toEqual({ content: "current-body", isCurrent: true });
  });

  it("fast-paths when item.version is populated and matches the requested id", async () => {
    // Cover the `item.version === versionId` short-circuit even though the
    // mock doesn't surface `version` itself: synthesise an item with a known
    // version field to exercise the path Graph takes when it does include
    // the field.
    const item = await getDriveItem(client, gid("file-md-1"), testSignal());
    const itemWithVersion = { ...item, version: "synthetic-rev" };
    const body = await getRevisionContent(
      client,
      itemWithVersion,
      gid("synthetic-rev"),
      testSignal(),
    );
    // The mock ignores the synthetic version and returns the live content
    // because /content is served from the file's current bytes.
    expect(body.isCurrent).toBe(true);
    expect(body.content).toBe("hello world!");
  });

  it("returns historical content when the revision id matches a /versions entry", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    const beforeVersions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    const originalRevision = beforeVersions[0]?.id;
    expect(originalRevision).toBeTruthy();
    await updateMarkdownFile(client, gid("file-md-1"), before.cTag!, "second-body", testSignal());
    const current = await getDriveItem(client, gid("file-md-1"), testSignal());
    const body = await getRevisionContent(client, current, gid(originalRevision!), testSignal());
    expect(body).toEqual({ content: "hello world!", isCurrent: false });
  });

  it("throws MarkdownUnknownVersionError for a revision id that matches neither", async () => {
    const item = await getDriveItem(client, gid("file-md-1"), testSignal());
    await expect(
      getRevisionContent(client, item, gid("bogus-revision"), testSignal()),
    ).rejects.toBeInstanceOf(MarkdownUnknownVersionError);
  });

  it("unknown-version error enumerates both the current revision and history", async () => {
    const before = await getDriveItem(client, gid("file-md-1"), testSignal());
    const beforeVersions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    const originalRevision = beforeVersions[0]?.id;
    expect(originalRevision).toBeTruthy();
    await updateMarkdownFile(client, gid("file-md-1"), before.cTag!, "v2", testSignal());
    const current = await getDriveItem(client, gid("file-md-1"), testSignal());
    const currentVersions = await listDriveItemVersions(client, gid("file-md-1"), testSignal());
    const currentRevision = currentVersions[0]?.id;
    expect(currentRevision).toBeTruthy();
    try {
      await getRevisionContent(client, current, gid("nope"), testSignal());
      throw new Error("expected MarkdownUnknownVersionError");
    } catch (err) {
      expect(err).toBeInstanceOf(MarkdownUnknownVersionError);
      const known = (err as MarkdownUnknownVersionError).availableVersionIds;
      expect(known).toContain(currentRevision);
      expect(known).toContain(originalRevision);
    }
  });

  // The "rejects empty versionId" test moved to `test/graph/ids.test.ts`
  // — per ADR-0005, passing an empty string is a compile-time error.
});

// ---------------------------------------------------------------------------
// Pagination via @odata.nextLink (folders > 200)
// ---------------------------------------------------------------------------

describe("listRootFolders / listMarkdownFiles pagination", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("listRootFolders returns all folders when there are more than one page (>200)", async () => {
    const total = 503; // 3 pages of 200
    env.state.driveRootChildren = Array.from({ length: total }, (_, i) => ({
      id: `folder-${String(i)}`,
      name: `Folder ${String(i).padStart(4, "0")}`,
      folder: { childCount: 0 },
    }));
    const folders = await listRootFolders(client, testSignal());
    expect(folders).toHaveLength(total);
    // First page boundary, mid page, and last page boundary all retained.
    expect(folders[0]?.id).toBe("folder-0");
    expect(folders[200]?.id).toBe("folder-200");
    expect(folders.at(-1)?.id).toBe(`folder-${String(total - 1)}`);
  });

  it("listRootFolders still filters out non-folder entries across all pages", async () => {
    const total = 250;
    env.state.driveRootChildren = Array.from({ length: total }, (_, i) =>
      i % 2 === 0
        ? { id: `f-${String(i)}`, name: `F${String(i)}`, folder: { childCount: 0 } }
        : { id: `s-${String(i)}`, name: `s${String(i)}.txt`, file: { mimeType: "text/plain" } },
    );
    const folders = await listRootFolders(client, testSignal());
    // Even indices are folders -> 125 folders in 250 entries.
    expect(folders).toHaveLength(125);
    expect(folders.every((f) => f.folder !== undefined)).toBe(true);
  });

  it("listMarkdownFiles paginates folder children", async () => {
    const total = 410;
    env.state.driveFolderChildren.set(
      "big-folder",
      Array.from({ length: total }, (_, i) => ({
        id: `md-${String(i)}`,
        name: `note-${String(i).padStart(4, "0")}.md`,
        size: 10,
        file: { mimeType: "text/markdown" },
      })),
    );
    const files = await listMarkdownFiles(client, gid("big-folder"), testSignal());
    expect(files).toHaveLength(total);
  });
});

// ---------------------------------------------------------------------------
// assertValidGraphId — back-compat re-export from src/graph/markdown.ts
//
// The validator's behaviour is exhaustively covered in
// `test/graph/ids.test.ts`. The retained tests here only confirm that the
// legacy import path (`from "../../src/graph/markdown"`) still resolves to
// the same validator, so existing imports keep working through the
// migration. Per ADR-0005, the previous "guards every Graph helper" test
// is removed because passing an unvalidated string is now a compile-time
// error at every helper boundary.
// ---------------------------------------------------------------------------

import { assertValidGraphId } from "../../src/graph/markdown.js";

describe("assertValidGraphId (back-compat re-export)", () => {
  it("returns the validated value for a realistic Graph ID", () => {
    expect(assertValidGraphId("itemId", "01ABCDEFGHIJKLMN")).toBe("01ABCDEFGHIJKLMN");
  });

  it("throws on a structurally invalid value", () => {
    expect(() => assertValidGraphId("itemId", "a/b")).toThrow("path separators");
  });
});

describe("buildMarkdownPreviewUrl", () => {
  const drive = {
    id: "drive-1",
    driveType: "business",
    webUrl: "https://conativeab-my.sharepoint.com/personal/simon_co-native_com/Documents",
  };

  it("matches the user-provided example URL exactly", () => {
    // From the user: previewing "Dresden Files.md" inside the "markdown" folder
    // should yield this exact /my?id=...&parent=... URL.
    const url = buildMarkdownPreviewUrl(drive, {
      id: "x",
      name: "Dresden Files.md",
      parentReference: { path: "/drive/root:/markdown" },
    });
    expect(url).toBe(
      "https://conativeab-my.sharepoint.com/my" +
        "?id=%2Fpersonal%2Fsimon_co-native_com%2FDocuments%2Fmarkdown%2FDresden%20Files.md" +
        "&parent=%2Fpersonal%2Fsimon_co-native_com%2FDocuments%2Fmarkdown",
    );
  });

  it("encodes spaces as %20 (not +)", () => {
    const url = buildMarkdownPreviewUrl(
      { id: "d", webUrl: "https://contoso-my.sharepoint.com/personal/u_contoso_com/Documents" },
      {
        id: "x",
        name: "My Notes.md",
        parentReference: { path: "/drive/root:/My Folder" },
      },
    );
    expect(url).toContain("%20");
    expect(url).not.toContain("+");
    expect(url).toContain("%2FMy%20Folder%2FMy%20Notes.md");
  });

  it("supports the /drives/{driveId}/root: parentReference shape", () => {
    const url = buildMarkdownPreviewUrl(drive, {
      id: "x",
      name: "a.md",
      parentReference: { path: "/drives/drive-1/root:/markdown" },
    });
    expect(url).toContain("%2Fmarkdown%2Fa.md");
    expect(url).toContain("parent=%2Fpersonal%2Fsimon_co-native_com%2FDocuments%2Fmarkdown");
  });

  it("throws when drive.webUrl is missing", () => {
    expect(() =>
      buildMarkdownPreviewUrl(
        { id: "d" },
        { id: "x", name: "a.md", parentReference: { path: "/drive/root:/m" } },
      ),
    ).toThrow(/no webUrl/);
  });

  it("throws when drive.webUrl is unparseable", () => {
    expect(() =>
      buildMarkdownPreviewUrl(
        { id: "d", webUrl: "not a url" },
        { id: "x", name: "a.md", parentReference: { path: "/drive/root:/m" } },
      ),
    ).toThrow(/not a valid URL/);
  });

  it("throws when parentReference.path is missing", () => {
    expect(() => buildMarkdownPreviewUrl(drive, { id: "x", name: "a.md" })).toThrow(
      /no parentReference\.path/,
    );
  });

  it("throws when parentReference.path lacks the root: marker", () => {
    expect(() =>
      buildMarkdownPreviewUrl(drive, {
        id: "x",
        name: "a.md",
        parentReference: { path: "/something/else" },
      }),
    ).toThrow(/unexpected parentReference\.path/);
  });

  it("rejects consumer OneDrive (onedrive.live.com)", () => {
    expect(() =>
      buildMarkdownPreviewUrl(
        { id: "d", driveType: "personal", webUrl: "https://onedrive.live.com/?id=root" },
        { id: "x", name: "a.md", parentReference: { path: "/drive/root:/m" } },
      ),
    ).toThrow(/onedrive\.live\.com/);
  });
});
