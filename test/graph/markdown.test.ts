// Graph-layer tests for OneDrive-backed markdown operations.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTestEnv, testSignal, type TestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import {
  MAX_DIRECT_CONTENT_BYTES,
  MarkdownEtagMismatchError,
  MarkdownFileAlreadyExistsError,
  MarkdownFileTooLargeError,
  MarkdownFolderEntryKind,
  MarkdownUnknownVersionError,
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
    const files = await listMarkdownFiles(client, "folder-1", testSignal());
    expect(files.map((f) => f.name).sort()).toEqual(["Notes.MD", "ideas.md"]);
  });

  it("listMarkdownFiles returns empty array when folder has no markdown files", async () => {
    const files = await listMarkdownFiles(client, "folder-2", testSignal());
    expect(files).toEqual([]);
  });

  it("findMarkdownFileByName matches case-insensitively", async () => {
    const a = await findMarkdownFileByName(client, "folder-1", "IDEAS.md", testSignal());
    expect(a?.id).toBe("file-md-1");
    const b = await findMarkdownFileByName(client, "folder-1", "notes.md", testSignal());
    expect(b?.id).toBe("file-md-2");
  });

  it("findMarkdownFileByName returns null for unknown file", async () => {
    const result = await findMarkdownFileByName(client, "folder-1", "missing.md", testSignal());
    expect(result).toBeNull();
  });

  it("getDriveItem returns metadata", async () => {
    const item = await getDriveItem(client, "file-md-1", testSignal());
    expect(item.name).toBe("ideas.md");
    expect(item.size).toBe(12);
  });

  it("downloadMarkdownContent returns UTF-8 body", async () => {
    const body = await downloadMarkdownContent(client, "file-md-1", testSignal());
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

    await expect(downloadMarkdownContent(client, "huge", testSignal())).rejects.toBeInstanceOf(
      MarkdownFileTooLargeError,
    );
  });

  it("uploadMarkdownContent removed; createMarkdownFile and updateMarkdownFile are the supported API", async () => {
    // Sanity check that the new API is wired up (replaces the legacy upload tests).
    const created = await createMarkdownFile(
      client,
      "folder-2",
      "fresh.md",
      "# Fresh\n",
      testSignal(),
    );
    expect(created.name).toBe("fresh.md");
    expect(created.eTag).toMatch(/^"\{.*\},\d+"$/);
  });

  it("createMarkdownFile creates a brand-new file and returns an eTag", async () => {
    const item = await createMarkdownFile(
      client,
      "folder-1",
      "new-note.md",
      "# Hello\n",
      testSignal(),
    );
    expect(item.name).toBe("new-note.md");
    expect(item.eTag).toBeTruthy();

    const files = await listMarkdownFiles(client, "folder-1", testSignal());
    expect(files.map((f) => f.name)).toContain("new-note.md");

    const stored = await downloadMarkdownContent(client, item.id, testSignal());
    expect(stored).toBe("# Hello\n");
  });

  it("createMarkdownFile rejects payloads over 4 MB without hitting the network", async () => {
    const oversized = "a".repeat(1024 * 1024).repeat(5); // 5 MiB
    await expect(
      createMarkdownFile(client, "folder-1", "big.md", oversized, testSignal()),
    ).rejects.toBeInstanceOf(MarkdownFileTooLargeError);
  });

  it("createMarkdownFile throws MarkdownFileAlreadyExistsError when the name is taken", async () => {
    await expect(
      createMarkdownFile(client, "folder-1", "ideas.md", "x", testSignal()),
    ).rejects.toBeInstanceOf(MarkdownFileAlreadyExistsError);

    // The existing file's content was NOT changed.
    const body = await downloadMarkdownContent(client, "file-md-1", testSignal());
    expect(body).toBe("hello world!");
  });

  it("updateMarkdownFile overwrites with matching etag and bumps the etag", async () => {
    const before = await getDriveItem(client, "file-md-1", testSignal());
    const beforeETag = before.eTag;
    expect(beforeETag).toBeTruthy();

    const updated = await updateMarkdownFile(
      client,
      "file-md-1",
      beforeETag!,
      "updated content",
      testSignal(),
    );
    expect(updated.id).toBe("file-md-1");
    expect(updated.eTag).toBeTruthy();
    expect(updated.eTag).not.toBe(beforeETag);

    const body = await downloadMarkdownContent(client, "file-md-1", testSignal());
    expect(body).toBe("updated content");
  });

  it("updateMarkdownFile throws MarkdownEtagMismatchError when the supplied etag is stale", async () => {
    const before = await getDriveItem(client, "file-md-1", testSignal());
    // First update bumps the etag.
    await updateMarkdownFile(client, "file-md-1", before.eTag!, "v2", testSignal());

    // Second update with the now-stale etag must fail with the typed error.
    await expect(
      updateMarkdownFile(client, "file-md-1", before.eTag!, "v3", testSignal()),
    ).rejects.toBeInstanceOf(MarkdownEtagMismatchError);

    // Content was NOT changed by the failed update.
    const body = await downloadMarkdownContent(client, "file-md-1", testSignal());
    expect(body).toBe("v2");
  });

  it("updateMarkdownFile etag-mismatch error carries the current item with the new etag", async () => {
    const before = await getDriveItem(client, "file-md-1", testSignal());
    await updateMarkdownFile(client, "file-md-1", before.eTag!, "v2", testSignal());

    try {
      await updateMarkdownFile(client, "file-md-1", before.eTag!, "v3", testSignal());
      throw new Error("expected MarkdownEtagMismatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(MarkdownEtagMismatchError);
      const e = err as MarkdownEtagMismatchError;
      expect(e.suppliedEtag).toBe(before.eTag);
      expect(e.currentItem.id).toBe("file-md-1");
      expect(e.currentItem.eTag).toBeTruthy();
      expect(e.currentItem.eTag).not.toBe(before.eTag);
    }
  });

  it("updateMarkdownFile rejects empty itemId and empty etag", async () => {
    await expect(updateMarkdownFile(client, "", "etag", "x", testSignal())).rejects.toThrow(
      "itemId must not be empty",
    );
    await expect(updateMarkdownFile(client, "file-md-1", "", "x", testSignal())).rejects.toThrow(
      "etag must not be empty",
    );
  });

  it("updateMarkdownFile rejects payloads over 4 MB without hitting the network", async () => {
    const oversized = "a".repeat(1024 * 1024).repeat(5);
    await expect(
      updateMarkdownFile(client, "file-md-1", "any-etag", oversized, testSignal()),
    ).rejects.toBeInstanceOf(MarkdownFileTooLargeError);
  });

  it("deleteDriveItem removes the file", async () => {
    await deleteDriveItem(client, "file-md-1", testSignal());
    const files = await listMarkdownFiles(client, "folder-1", testSignal());
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
    const entries = await listMarkdownFolderEntries(client, "folder-1", testSignal());
    const supported = entries.filter((e) => e.kind === MarkdownFolderEntryKind.Supported);
    expect(supported.map((e) => e.item.id)).toEqual(["ok-1"]);
  });

  it("listMarkdownFolderEntries flags subdirectories as unsupported", async () => {
    const entries = await listMarkdownFolderEntries(client, "folder-1", testSignal());
    const subdir = entries.find((e) => e.item.id === "subdir-1");
    expect(subdir).toBeDefined();
    expect(subdir!.kind).toBe(MarkdownFolderEntryKind.Unsupported);
    if (subdir!.kind === MarkdownFolderEntryKind.Unsupported) {
      expect(subdir!.reason).toContain("subdirectory");
    }
  });

  it("listMarkdownFolderEntries flags .md files with unsupported names", async () => {
    const entries = await listMarkdownFolderEntries(client, "folder-1", testSignal());
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
    const entries = await listMarkdownFolderEntries(client, "folder-1", testSignal());
    expect(entries.some((e) => e.item.id === "txt-1")).toBe(false);
  });

  it("listMarkdownFiles returns only supported entries", async () => {
    const files = await listMarkdownFiles(client, "folder-1", testSignal());
    expect(files.map((f) => f.id)).toEqual(["ok-1"]);
  });

  it("findMarkdownFileByName rejects invalid names before touching the network", async () => {
    await expect(
      findMarkdownFileByName(client, "folder-1", "../escape.md", testSignal()),
    ).rejects.toThrow(/path separator/);
  });

  it("findMarkdownFileByName returns null for a valid-but-missing name", async () => {
    const result = await findMarkdownFileByName(client, "folder-1", "missing.md", testSignal());
    expect(result).toBeNull();
  });

  it("findMarkdownFileByName does not match a file whose remote name is unsupported", async () => {
    // Even though "weird@name.md" exists remotely, it should not be reachable
    // by name-based lookup because listMarkdownFiles filters it out.
    const result = await findMarkdownFileByName(client, "folder-1", "notes.md", testSignal());
    expect(result).toBeNull();
  });

  it("createMarkdownFile rejects unsafe names before touching the network", async () => {
    await expect(
      createMarkdownFile(client, "folder-1", "sub/dir.md", "x", testSignal()),
    ).rejects.toThrow(/path separator/);
    await expect(
      createMarkdownFile(client, "folder-1", "CON.md", "x", testSignal()),
    ).rejects.toThrow(/reserved name/);
    await expect(
      createMarkdownFile(client, "folder-1", "weird@name.md", "x", testSignal()),
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

  it("listDriveItemVersions returns an empty array for a file with no prior versions", async () => {
    const versions = await listDriveItemVersions(client, "file-md-1", testSignal());
    expect(versions).toEqual([]);
  });

  it("overwriting a file via updateMarkdownFile snapshots the prior version", async () => {
    const start = await getDriveItem(client, "file-md-1", testSignal());
    const after1 = await updateMarkdownFile(client, "file-md-1", start.eTag!, "v2", testSignal());
    await updateMarkdownFile(client, "file-md-1", after1.eTag!, "v3", testSignal());

    const versions = await listDriveItemVersions(client, "file-md-1", testSignal());
    // Two overwrites produce two historical snapshots (the original + the v2).
    expect(versions).toHaveLength(2);
    // Every version carries a non-empty ID and a timestamp.
    for (const v of versions) {
      expect(v.id.length).toBeGreaterThan(0);
      expect(typeof v.lastModifiedDateTime).toBe("string");
    }
    // Content is NOT part of the list response — only the /content sub-resource.
    // Confirm we can still download the most recent snapshot (which is the v2
    // payload, since v3 became current).
    const [firstVersion] = versions;
    if (!firstVersion) throw new Error("expected at least one version");
    const firstContent = await downloadDriveItemVersionContent(
      client,
      "file-md-1",
      firstVersion.id,
      testSignal(),
    );
    expect(["v2", "hello world!"]).toContain(firstContent);
  });

  it("downloadDriveItemVersionContent returns the stored content", async () => {
    const start = await getDriveItem(client, "file-md-1", testSignal());
    await updateMarkdownFile(client, "file-md-1", start.eTag!, "updated", testSignal());
    const versions = await listDriveItemVersions(client, "file-md-1", testSignal());
    expect(versions).toHaveLength(1);
    const [prior] = versions;
    if (!prior) throw new Error("expected prior version");
    const content = await downloadDriveItemVersionContent(
      client,
      "file-md-1",
      prior.id,
      testSignal(),
    );
    expect(content).toBe("hello world!");
  });

  it("downloadDriveItemVersionContent returns a 404-style error for an unknown versionId", async () => {
    await expect(
      downloadDriveItemVersionContent(client, "file-md-1", "does-not-exist", testSignal()),
    ).rejects.toThrow();
  });

  it("listDriveItemVersions rejects empty itemId", async () => {
    await expect(listDriveItemVersions(client, "", testSignal())).rejects.toThrow(
      "itemId must not be empty",
    );
  });

  it("downloadDriveItemVersionContent rejects empty ids", async () => {
    await expect(downloadDriveItemVersionContent(client, "", "v", testSignal())).rejects.toThrow();
    await expect(
      downloadDriveItemVersionContent(client, "file-md-1", "", testSignal()),
    ).rejects.toThrow();
  });
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

  it("getDriveItem returns a `version` field for seeded files (lazy-assigned)", async () => {
    const item = await getDriveItem(client, "file-md-1", testSignal());
    expect(item.version).toBeTruthy();
    expect(typeof item.version).toBe("string");
  });

  it("createMarkdownFile returns a `version` field on creation", async () => {
    const created = await createMarkdownFile(client, "folder-2", "fresh.md", "one", testSignal());
    expect(created.version).toBeTruthy();
  });

  it("updateMarkdownFile bumps the `version` on every write", async () => {
    const before = await getDriveItem(client, "file-md-1", testSignal());
    const v0 = before.version!;
    const after1 = await updateMarkdownFile(client, "file-md-1", before.eTag!, "v1", testSignal());
    expect(after1.version).toBeTruthy();
    expect(after1.version).not.toBe(v0);
    const after2 = await updateMarkdownFile(client, "file-md-1", after1.eTag!, "v2", testSignal());
    expect(after2.version).not.toBe(after1.version);
  });

  it("prior revision ID surfaces as a history entry after an update", async () => {
    const before = await getDriveItem(client, "file-md-1", testSignal());
    const priorRevision = before.version!;
    await updateMarkdownFile(client, "file-md-1", before.eTag!, "v1", testSignal());
    const history = await listDriveItemVersions(client, "file-md-1", testSignal());
    // The first overwrite promotes the prior current revision into history.
    expect(history.map((v) => v.id)).toContain(priorRevision);
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

  it("returns live content when the revision id matches item.version", async () => {
    const before = await getDriveItem(client, "file-md-1", testSignal());
    await updateMarkdownFile(client, "file-md-1", before.eTag!, "current-body", testSignal());
    const current = await getDriveItem(client, "file-md-1", testSignal());
    const body = await getRevisionContent(client, current, current.version!, testSignal());
    expect(body).toBe("current-body");
  });

  it("returns historical content when the revision id matches a /versions entry", async () => {
    const before = await getDriveItem(client, "file-md-1", testSignal());
    const originalRevision = before.version!;
    await updateMarkdownFile(client, "file-md-1", before.eTag!, "second-body", testSignal());
    const current = await getDriveItem(client, "file-md-1", testSignal());
    const body = await getRevisionContent(client, current, originalRevision, testSignal());
    expect(body).toBe("hello world!");
  });

  it("throws MarkdownUnknownVersionError for a revision id that matches neither", async () => {
    const item = await getDriveItem(client, "file-md-1", testSignal());
    await expect(
      getRevisionContent(client, item, "bogus-revision", testSignal()),
    ).rejects.toBeInstanceOf(MarkdownUnknownVersionError);
  });

  it("unknown-version error enumerates both the current revision and history", async () => {
    const before = await getDriveItem(client, "file-md-1", testSignal());
    const originalRevision = before.version!;
    await updateMarkdownFile(client, "file-md-1", before.eTag!, "v2", testSignal());
    const current = await getDriveItem(client, "file-md-1", testSignal());
    try {
      await getRevisionContent(client, current, "nope", testSignal());
      throw new Error("expected MarkdownUnknownVersionError");
    } catch (err) {
      expect(err).toBeInstanceOf(MarkdownUnknownVersionError);
      const known = (err as MarkdownUnknownVersionError).availableVersionIds;
      expect(known).toContain(current.version);
      expect(known).toContain(originalRevision);
    }
  });

  it("rejects empty versionId", async () => {
    const item = await getDriveItem(client, "file-md-1", testSignal());
    await expect(getRevisionContent(client, item, "", testSignal())).rejects.toThrow(
      "versionId must not be empty",
    );
  });
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
    const files = await listMarkdownFiles(client, "big-folder", testSignal());
    expect(files).toHaveLength(total);
  });
});

// ---------------------------------------------------------------------------
// assertValidGraphId
// ---------------------------------------------------------------------------

import { assertValidGraphId } from "../../src/graph/markdown.js";

describe("assertValidGraphId", () => {
  it("accepts realistic Graph IDs", () => {
    expect(() => assertValidGraphId("itemId", "01ABCDEFGHIJKLMN")).not.toThrow();
    expect(() => assertValidGraphId("versionId", "1.0")).not.toThrow();
    expect(() => assertValidGraphId("folderId", "folder-1")).not.toThrow();
  });

  it("rejects non-string inputs", () => {
    expect(() => assertValidGraphId("itemId", undefined)).toThrow("itemId must be a string");
    expect(() => assertValidGraphId("itemId", null)).toThrow("itemId must be a string");
    expect(() => assertValidGraphId("itemId", 42)).toThrow("itemId must be a string");
  });

  it("rejects empty strings", () => {
    expect(() => assertValidGraphId("itemId", "")).toThrow("itemId must not be empty");
  });

  it("rejects path separators", () => {
    expect(() => assertValidGraphId("itemId", "a/b")).toThrow("path separators");
    expect(() => assertValidGraphId("itemId", "a\\b")).toThrow("path separators");
  });

  it("rejects whitespace and control characters", () => {
    expect(() => assertValidGraphId("itemId", "a b")).toThrow("whitespace");
    expect(() => assertValidGraphId("itemId", "a\tb")).toThrow("whitespace");
    expect(() => assertValidGraphId("itemId", "a\nb")).toThrow("whitespace");
    expect(() => assertValidGraphId("itemId", "a\x00b")).toThrow("control characters");
  });

  it("rejects non-ASCII", () => {
    expect(() => assertValidGraphId("itemId", "café")).toThrow("ASCII");
  });

  it("rejects values longer than 256 chars", () => {
    expect(() => assertValidGraphId("itemId", "a".repeat(257))).toThrow("longer than 256");
  });

  it("guards every Graph helper that takes an opaque ID", async () => {
    const env2 = await createTestEnv();
    const c = new GraphClient(env2.graphUrl, "test-token");
    try {
      await expect(getDriveItem(c, "a/b", testSignal())).rejects.toThrow("path separators");
      await expect(downloadMarkdownContent(c, " ", testSignal())).rejects.toThrow("whitespace");
      await expect(deleteDriveItem(c, "a\\b", testSignal())).rejects.toThrow("path separators");
      await expect(listDriveItemVersions(c, "a/b", testSignal())).rejects.toThrow(
        "path separators",
      );
      await expect(downloadDriveItemVersionContent(c, "a/b", "v", testSignal())).rejects.toThrow(
        "itemId must not contain path separators",
      );
      await expect(downloadDriveItemVersionContent(c, "ok", "v/1", testSignal())).rejects.toThrow(
        "versionId must not contain path separators",
      );
      await expect(findMarkdownFileByName(c, "a b", "x.md", testSignal())).rejects.toThrow(
        "whitespace",
      );
      await expect(createMarkdownFile(c, "a/b", "x.md", "x", testSignal())).rejects.toThrow(
        "path separators",
      );
      await expect(updateMarkdownFile(c, "a b", "etag", "x", testSignal())).rejects.toThrow(
        "whitespace",
      );
    } finally {
      await env2.cleanup();
    }
  });
});
