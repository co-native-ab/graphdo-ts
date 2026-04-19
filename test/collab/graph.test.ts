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
  writeAuthoritative,
  writeProjectFile,
  ProjectFileAlreadyExistsError,
  COLLAB_CONTENT_TYPE_MARKDOWN,
  COLLAB_CONTENT_TYPE_BINARY,
} from "../../src/collab/graph.js";
import { CollabCTagMismatchError } from "../../src/errors.js";
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

  describe("writeAuthoritative", () => {
    it("byId replace returns updated item with bumped cTag", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      // Ensure the file's cTag is materialised (lazily assigned on first GET).
      const before = await getDriveItem(client, gid("file-spec"), testSignal());
      expect(before.cTag).toBeDefined();
      const cTag = before.cTag!;

      const updated = await writeAuthoritative(
        client,
        gid("file-spec"),
        cTag,
        "# spec\nNew content.",
        testSignal(),
      );
      expect(updated.id).toBe("file-spec");
      expect(updated.cTag).toBeDefined();
      expect(updated.cTag).not.toBe(cTag);
      // Body actually updated.
      const after = await getDriveItemContent(client, gid("file-spec"), testSignal());
      expect(after).toBe("# spec\nNew content.");
    });

    it("throws CollabCTagMismatchError on 412 with current cTag + revision + item", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      // Materialise the cTag so the mock has a known value.
      await getDriveItem(client, gid("file-spec"), testSignal());

      const stale = "stale-ctag-value";
      try {
        await writeAuthoritative(
          client,
          gid("file-spec"),
          stale,
          "# spec\nWill not land.",
          testSignal(),
        );
        throw new Error("expected CollabCTagMismatchError");
      } catch (err) {
        expect(err).toBeInstanceOf(CollabCTagMismatchError);
        const e = err as CollabCTagMismatchError;
        expect(e.itemId).toBe("file-spec");
        expect(e.suppliedCTag).toBe(stale);
        expect(e.currentCTag).toBeDefined();
        expect(e.currentCTag).not.toBe(stale);
        // OneDrive's `version` field is surfaced as `currentRevision`. The
        // mock mirrors real Graph in not always returning `version` on
        // `GET /me/drive/items/{id}` — assert the wiring (`currentRevision`
        // is read straight off `currentItem.version`) without forcing a
        // value the mock won't provide.
        expect(e.currentRevision).toBe(e.currentItem.version);
        expect(e.currentItem.id).toBe("file-spec");
        // Helpful error message includes the supplied cTag for diagnosis.
        expect(e.message).toContain(stale);
      }
    });

    it("rejects empty cTag (would defeat the CAS contract)", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      await expect(
        writeAuthoritative(client, gid("file-spec"), "", "body", testSignal()),
      ).rejects.toThrow(/cTag must not be empty/);
    });

    it("throws MarkdownFileTooLargeError before issuing the upload when content exceeds 4 MiB", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const oversized = "x".repeat(MAX_DIRECT_CONTENT_BYTES + 1);
      await expect(
        writeAuthoritative(client, gid("file-spec"), "any-ctag", oversized, testSignal()),
      ).rejects.toThrow(MarkdownFileTooLargeError);
    });
  });

  describe("writeProjectFile", () => {
    it("byPath create succeeds and returns new drive item (201 path)", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const created = await writeProjectFile(
        client,
        {
          kind: "create",
          folderId: gid("folder-proj"),
          fileName: "draft-1.md",
          contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
        },
        "# draft body",
        testSignal(),
      );
      expect(created.name).toBe("draft-1.md");
      expect(created.id).toBeDefined();
      expect(created.cTag).toBeDefined();

      // The new file is now visible in the listing.
      const children = await listChildren(client, gid("folder-proj"), testSignal());
      const names = children.map((c) => c.name).sort();
      expect(names).toContain("draft-1.md");
    });

    it("byPath create raises ProjectFileAlreadyExistsError on 409 (conflictBehavior=fail)", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      // spec.md already exists at folder-proj root from beforeEach.
      try {
        await writeProjectFile(
          client,
          {
            kind: "create",
            folderId: gid("folder-proj"),
            fileName: "spec.md",
            contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
          },
          "# overwrite attempt",
          testSignal(),
        );
        throw new Error("expected ProjectFileAlreadyExistsError");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectFileAlreadyExistsError);
        const e = err as ProjectFileAlreadyExistsError;
        expect(e.folderId).toBe("folder-proj");
        expect(e.fileName).toBe("spec.md");
      }
    });

    it("byId replace succeeds and bumps cTag", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const before = await getDriveItem(client, gid("file-spec"), testSignal());
      const cTag = before.cTag!;

      const replaced = await writeProjectFile(
        client,
        {
          kind: "replace",
          itemId: gid("file-spec"),
          cTag,
          contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
        },
        "# replaced",
        testSignal(),
      );
      expect(replaced.id).toBe("file-spec");
      expect(replaced.cTag).not.toBe(cTag);
      const after = await getDriveItemContent(client, gid("file-spec"), testSignal());
      expect(after).toBe("# replaced");
    });

    it("byId replace raises CollabCTagMismatchError on stale cTag (412)", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      await getDriveItem(client, gid("file-spec"), testSignal());

      try {
        await writeProjectFile(
          client,
          {
            kind: "replace",
            itemId: gid("file-spec"),
            cTag: "stale",
            contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
          },
          "# will not land",
          testSignal(),
        );
        throw new Error("expected CollabCTagMismatchError");
      } catch (err) {
        expect(err).toBeInstanceOf(CollabCTagMismatchError);
        const e = err as CollabCTagMismatchError;
        expect(e.suppliedCTag).toBe("stale");
        expect(e.currentCTag).toBeDefined();
        expect(e.currentItem.id).toBe("file-spec");
      }
    });

    it("byId replace rejects empty cTag", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      await expect(
        writeProjectFile(
          client,
          {
            kind: "replace",
            itemId: gid("file-spec"),
            cTag: "",
            contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
          },
          "x",
          testSignal(),
        ),
      ).rejects.toThrow(/cTag must not be empty/);
    });

    it("accepts Uint8Array binary content (e.g. attachments)", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      // ASCII-only bytes so the mock's string-decode path round-trips
      // them faithfully (the mock reads upload bodies as UTF-8 strings;
      // a real Graph backend would store the bytes verbatim).
      const bytes = new TextEncoder().encode("PNG-DATA");
      const created = await writeProjectFile(
        client,
        {
          kind: "create",
          folderId: gid("folder-proj"),
          fileName: "diagram.png",
          contentType: COLLAB_CONTENT_TYPE_BINARY,
        },
        bytes,
        testSignal(),
      );
      expect(created.name).toBe("diagram.png");
      expect(created.size).toBe(bytes.byteLength);
    });

    it("enforces 4 MiB cap for both create and replace targets", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const oversized = "x".repeat(MAX_DIRECT_CONTENT_BYTES + 1);
      await expect(
        writeProjectFile(
          client,
          {
            kind: "create",
            folderId: gid("folder-proj"),
            fileName: "big.md",
            contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
          },
          oversized,
          testSignal(),
        ),
      ).rejects.toThrow(MarkdownFileTooLargeError);
      await expect(
        writeProjectFile(
          client,
          {
            kind: "replace",
            itemId: gid("file-spec"),
            cTag: "any",
            contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
          },
          oversized,
          testSignal(),
        ),
      ).rejects.toThrow(MarkdownFileTooLargeError);
    });

    it("byPath create rejects unsafe file names (path separators, control chars, dot segments)", async () => {
      const client = new GraphClient(env.graphUrl, staticToken("test-token"));
      const target = (fileName: string): Parameters<typeof writeProjectFile>[1] => ({
        kind: "create",
        folderId: gid("folder-proj"),
        fileName,
        contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
      });
      await expect(writeProjectFile(client, target(""), "x", testSignal())).rejects.toThrow(
        /must not be empty/,
      );
      await expect(writeProjectFile(client, target("a/b.md"), "x", testSignal())).rejects.toThrow(
        /path separators/,
      );
      await expect(writeProjectFile(client, target("a\\b.md"), "x", testSignal())).rejects.toThrow(
        /path separators/,
      );
      await expect(writeProjectFile(client, target("."), "x", testSignal())).rejects.toThrow(
        /'\.' or '\.\.'/,
      );
      await expect(writeProjectFile(client, target(".."), "x", testSignal())).rejects.toThrow(
        /'\.' or '\.\.'/,
      );
      await expect(
        writeProjectFile(client, target("bad\u0001name.md"), "x", testSignal()),
      ).rejects.toThrow(/control characters/);
    });
  });
});
