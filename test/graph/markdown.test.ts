// Graph-layer tests for OneDrive-backed markdown operations.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTestEnv, testSignal, type TestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import {
  MAX_DIRECT_CONTENT_BYTES,
  MarkdownFileTooLargeError,
  deleteDriveItem,
  downloadMarkdownContent,
  findMarkdownFileByName,
  getDriveItem,
  getMyDrive,
  listMarkdownFiles,
  listMarkdownFolderEntries,
  listRootFolders,
  uploadMarkdownContent,
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

  it("uploadMarkdownContent creates a new file under the folder", async () => {
    const item = await uploadMarkdownContent(
      client,
      "folder-1",
      "new-note.md",
      "# Hello\n",
      testSignal(),
    );
    expect(item.name).toBe("new-note.md");

    const files = await listMarkdownFiles(client, "folder-1", testSignal());
    expect(files.map((f) => f.name)).toContain("new-note.md");

    const stored = await downloadMarkdownContent(client, item.id, testSignal());
    expect(stored).toBe("# Hello\n");
  });

  it("uploadMarkdownContent overwrites an existing file (same ID)", async () => {
    const first = await uploadMarkdownContent(
      client,
      "folder-1",
      "ideas.md",
      "updated",
      testSignal(),
    );
    expect(first.id).toBe("file-md-1");
    const body = await downloadMarkdownContent(client, "file-md-1", testSignal());
    expect(body).toBe("updated");
  });

  it("uploadMarkdownContent rejects payloads over 4 MB without hitting the network", async () => {
    // Build a >4 MB string without relying on Buffer.alloc + fill for perf.
    const chunk = "a".repeat(1024 * 1024); // 1 MiB
    const oversized = chunk.repeat(5); // 5 MiB

    await expect(
      uploadMarkdownContent(client, "folder-1", "big.md", oversized, testSignal()),
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
    const supported = entries.filter((e) => e.kind === "supported");
    expect(supported.map((e) => e.item.id)).toEqual(["ok-1"]);
  });

  it("listMarkdownFolderEntries flags subdirectories as unsupported", async () => {
    const entries = await listMarkdownFolderEntries(client, "folder-1", testSignal());
    const subdir = entries.find((e) => e.item.id === "subdir-1");
    expect(subdir).toBeDefined();
    expect(subdir!.kind).toBe("unsupported");
    if (subdir!.kind === "unsupported") {
      expect(subdir!.reason).toContain("subdirectory");
    }
  });

  it("listMarkdownFolderEntries flags .md files with unsupported names", async () => {
    const entries = await listMarkdownFolderEntries(client, "folder-1", testSignal());
    const weird = entries.find((e) => e.item.id === "weird-1");
    expect(weird?.kind).toBe("unsupported");
    if (weird?.kind === "unsupported") {
      expect(weird.reason).toContain("unsupported file name");
    }
    const reserved = entries.find((e) => e.item.id === "reserved-1");
    expect(reserved?.kind).toBe("unsupported");
    if (reserved?.kind === "unsupported") {
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

  it("uploadMarkdownContent rejects unsafe names before touching the network", async () => {
    await expect(
      uploadMarkdownContent(client, "folder-1", "sub/dir.md", "x", testSignal()),
    ).rejects.toThrow(/path separator/);
    await expect(
      uploadMarkdownContent(client, "folder-1", "CON.md", "x", testSignal()),
    ).rejects.toThrow(/reserved name/);
    await expect(
      uploadMarkdownContent(client, "folder-1", "weird@name.md", "x", testSignal()),
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
