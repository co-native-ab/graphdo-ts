// Unit tests for the collab v1 Graph helpers.
//
// W2 Day 4 adds:
//   - `getDriveItemContent` — content download with 4 MiB guard.
//   - `listChildren` — promoted to export, basic listing.
//   - `walkAttachmentsTree` — recursive tree walk with depth cap.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTestEnv, testSignal, gid } from "../helpers.js";
import type { TestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import {
  getDriveItem,
  getDriveItemContent,
  listChildren,
  walkAttachmentsTree,
} from "../../src/collab/graph.js";
import { MarkdownFileTooLargeError, MAX_DIRECT_CONTENT_BYTES } from "../../src/graph/markdown.js";

let env: TestEnv;

function staticToken(token: string): { getToken: () => Promise<string> } {
  return { getToken: () => Promise.resolve(token) };
}

describe("collab/graph helpers", () => {
  beforeEach(async () => {
    env = await createTestEnv();
    // Seed a folder structure
    env.state.driveRootChildren = [
      {
        id: "folder-proj",
        name: "Project",
        folder: {},
        lastModifiedDateTime: "2026-04-19T05:00:00Z",
      },
    ];
    env.state.driveFolderChildren.set("folder-proj", [
      {
        id: "file-spec",
        name: "spec.md",
        size: 12,
        lastModifiedDateTime: "2026-04-19T05:00:00Z",
        file: { mimeType: "text/markdown" },
        content: "# spec\nBody content here.",
      },
      {
        id: "folder-attachments",
        name: "attachments",
        folder: { childCount: 2 },
        lastModifiedDateTime: "2026-04-19T05:00:00Z",
      },
    ]);
    env.state.driveFolderChildren.set("folder-attachments", [
      {
        id: "file-img",
        name: "diagram.png",
        size: 1024,
        lastModifiedDateTime: "2026-04-19T06:00:00Z",
        file: { mimeType: "image/png" },
        content: "PNG-DATA",
      },
      {
        id: "folder-sub",
        name: "sub",
        folder: { childCount: 1 },
        lastModifiedDateTime: "2026-04-19T05:30:00Z",
      },
    ]);
    env.state.driveFolderChildren.set("folder-sub", [
      {
        id: "file-nested",
        name: "nested.txt",
        size: 50,
        lastModifiedDateTime: "2026-04-19T05:15:00Z",
        file: { mimeType: "text/plain" },
        content: "nested content",
      },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe("getDriveItem", () => {
    it("fetches a drive item by ID", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const item = await getDriveItem(client, gid("file-spec"), testSignal());
      expect(item.id).toBe("file-spec");
      expect(item.name).toBe("spec.md");
    });
  });

  describe("getDriveItemContent", () => {
    it("downloads content as UTF-8 string", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const content = await getDriveItemContent(client, gid("file-spec"), testSignal());
      expect(content).toBe("# spec\nBody content here.");
    });

    it("throws MarkdownFileTooLargeError when size exceeds limit", async () => {
      // Seed a file that's larger than 4 MiB
      const largeContent = "x".repeat(MAX_DIRECT_CONTENT_BYTES + 1);
      env.state.driveFolderChildren.set("folder-proj", [
        {
          id: "file-large",
          name: "large.md",
          size: MAX_DIRECT_CONTENT_BYTES + 1,
          lastModifiedDateTime: "2026-04-19T05:00:00Z",
          file: { mimeType: "text/markdown" },
          content: largeContent,
        },
      ]);

      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      await expect(getDriveItemContent(client, gid("file-large"), testSignal())).rejects.toThrow(
        MarkdownFileTooLargeError,
      );
    });
  });

  describe("listChildren", () => {
    it("lists immediate children of a folder", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const children = await listChildren(client, gid("folder-proj"), testSignal());
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.name).sort()).toEqual(["attachments", "spec.md"]);
    });
  });

  describe("walkAttachmentsTree", () => {
    it("recursively enumerates files in attachments folder", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const result = await walkAttachmentsTree(
        client,
        gid("folder-attachments"),
        testSignal(),
        100,
      );
      expect(result.truncated).toBe(false);
      expect(result.entries).toHaveLength(2);

      const paths = result.entries.map((e) => e.relativePath).sort();
      expect(paths).toEqual(["diagram.png", "sub/nested.txt"]);
    });

    it("respects budget and sets truncated flag", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const result = await walkAttachmentsTree(
        client,
        gid("folder-attachments"),
        testSignal(),
        1, // Only allow 1 entry
      );
      expect(result.truncated).toBe(true);
      expect(result.entries).toHaveLength(1);
    });

    it("returns empty array when folder does not exist (404)", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const result = await walkAttachmentsTree(
        client,
        gid("folder-nonexistent"),
        testSignal(),
        100,
      );
      expect(result.truncated).toBe(false);
      expect(result.entries).toHaveLength(0);
    });

    it("respects depth cap of 8", async () => {
      // Create a deeply nested structure
      let parentId = "folder-attachments";
      for (let i = 0; i < 10; i++) {
        const folderId = `folder-depth-${i}`;
        const fileId = `file-depth-${i}`;
        env.state.driveFolderChildren.set(parentId, [
          {
            id: folderId,
            name: `level${i}`,
            folder: { childCount: 1 },
            lastModifiedDateTime: "2026-04-19T05:00:00Z",
          },
          {
            id: fileId,
            name: `file${i}.txt`,
            size: 10,
            lastModifiedDateTime: "2026-04-19T05:00:00Z",
            file: { mimeType: "text/plain" },
            content: "data",
          },
        ]);
        parentId = folderId;
      }
      env.state.driveFolderChildren.set(parentId, []);

      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const result = await walkAttachmentsTree(
        client,
        gid("folder-attachments"),
        testSignal(),
        1000,
      );

      // Should stop at depth 8, so we get files from levels 0-7 (8 files)
      // but NOT from levels 8-9
      expect(result.entries.length).toBeLessThanOrEqual(8);
    });
  });
});
