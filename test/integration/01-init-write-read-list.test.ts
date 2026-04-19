// Integration test #01: init → write → read → list (collab v1 §10).
//
// **Status: W1 Day 3 happy path — sentinel + pin block.**
//
// W1 Day 3 implements only `session_init_project`. The downstream
// `collab_write` / `collab_read` / `collab_list_files` tools land in
// W2/W3, so the corresponding rows in this file are scaffolded as
// `it.todo`. The DoD per `docs/plans/collab-v1.md` §9 (W1 Day 3) is
// that the test reaches the sentinel-write step and asserts the pin
// block is written to local config.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";

import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  firstText,
  fetchCsrfToken,
  type IntegrationEnv,
  type ToolResult,
} from "./helpers.js";
import { MockAuthenticator } from "../mock-auth.js";
import {
  ProjectMetadataSchema,
  RecentsFileSchema,
  projectMetadataPath,
  recentsPath,
} from "../../src/collab/projects.js";
import { resetFormFactoryForTest } from "../../src/tools/collab-forms.js";

let env: IntegrationEnv;

/**
 * Build a browser spy that drives the chained init pickers:
 *
 *   - first call (folder picker) — POST `/select` with `folderId`
 *   - second call (file picker, W1 Day 4) — POST `/select` with the
 *     supplied `fileId` so the init flow records that file as the
 *     authoritative markdown.
 *
 * Subsequent calls beyond the second are ignored (defensive — the init
 * flow only opens two pickers). The most recent URL the spy was given
 * is captured so tests can assert on the loopback URL surface.
 *
 * For tests that only reach the folder picker (e.g. zero-md and
 * already-initialised error paths), `fileId` is unused.
 */
function pickerSpy(
  folderId: string,
  folderLabel: string,
  fileId?: string,
  fileLabel?: string,
): {
  spy: (url: string) => Promise<void>;
  captured: { url: string };
} {
  const captured = { url: "" };
  let call = 0;
  const spy = (url: string): Promise<void> => {
    captured.url = url;
    const which = call++;
    setTimeout(() => {
      void (async () => {
        const csrfToken = await fetchCsrfToken(url);
        if (which === 0) {
          await fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: folderId, label: folderLabel, csrfToken }),
          });
          return;
        }
        if (which === 1 && fileId !== undefined) {
          await fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: fileId,
              label: fileLabel ?? fileId,
              csrfToken,
            }),
          });
        }
      })();
    }, 150);
    return Promise.resolve();
  };
  return { spy, captured };
}

function seedSingleMarkdownFolder(env: IntegrationEnv): void {
  env.graphState.drive = {
    id: "mock-drive-1",
    driveType: "business",
    webUrl: "https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents",
  };
  env.graphState.driveRootChildren = [
    {
      id: "folder-proj",
      name: "Project Foo",
      folder: {},
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    },
  ];
  env.graphState.driveFolderChildren.set("folder-proj", [
    {
      id: "file-spec",
      name: "spec.md",
      size: 12,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "# spec\n",
    },
  ]);
}

describe("01-init-write-read-list", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedSingleMarkdownFolder(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  describe("session_init_project happy path (single root .md)", () => {
    it("writes the sentinel + pin block + recents entry", async () => {
      const { spy, captured } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
      const auth = new MockAuthenticator({
        token: "init-token",
        username: "alice@example.com",
      });
      const c = await createTestClient(env, auth, { openBrowser: spy });

      const result = (await c.callTool({
        name: "session_init_project",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("Project initialised.");
      expect(text).toContain("folderPath: /Project Foo");
      expect(text).toContain("authoritativeFile: spec.md");
      expect(captured.url).toMatch(/^http:\/\/127\.0\.0\.1:/);

      // Sentinel must exist in the mock Graph state under the new
      // .collab/ subfolder of the chosen project folder.
      const projectChildren = env.graphState.driveFolderChildren.get("folder-proj") ?? [];
      const collabFolder = projectChildren.find((c) => c.name === ".collab");
      expect(collabFolder).toBeDefined();
      const collabChildren = env.graphState.driveFolderChildren.get(collabFolder?.id ?? "") ?? [];
      const sentinelFile = collabChildren.find((c) => c.name === "project.json");
      expect(sentinelFile).toBeDefined();
      expect(sentinelFile?.content).toBeDefined();

      const sentinelDoc = JSON.parse(sentinelFile?.content ?? "") as Record<string, unknown>;
      expect(sentinelDoc["schemaVersion"]).toBe(1);
      expect(sentinelDoc["authoritativeFileId"]).toBe("file-spec");
      expect(sentinelDoc["authoritativeFileName"]).toBe("spec.md");
      expect((sentinelDoc["createdBy"] as { displayName?: string }).displayName).toBe(
        "alice@example.com",
      );
      const projectId = String(sentinelDoc["projectId"]);
      expect(projectId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      // Pin block: <configDir>/projects/<projectId>.json must exist with
      // the pin matching the sentinel's authoritativeFileId.
      const metaPath = projectMetadataPath(env.configDir, projectId);
      const metaRaw = await readFile(metaPath, "utf-8");
      const metaParsed = ProjectMetadataSchema.parse(JSON.parse(metaRaw));
      expect(metaParsed.projectId).toBe(projectId);
      expect(metaParsed.folderId).toBe("folder-proj");
      expect(metaParsed.folderPath).toBe("/Project Foo");
      expect(metaParsed.driveId).toBe("mock-drive-1");
      expect(metaParsed.pinnedAuthoritativeFileId).toBe("file-spec");
      expect(metaParsed.displayAuthoritativeFileName).toBe("spec.md");
      expect(metaParsed.pinnedAtFirstSeenCTag).toBe(sentinelFile?.cTag);
      expect(metaParsed.docId).toBeNull();
      expect(metaParsed.lastSeenAuthoritativeCTag).toBeNull();
      expect(metaParsed.lastSeenAuthoritativeRevision).toBeNull();

      // Recents file: <configDir>/projects/recent.json must include the
      // new project as the head entry.
      const recentsRaw = await readFile(recentsPath(env.configDir), "utf-8");
      const recentsParsed = RecentsFileSchema.parse(JSON.parse(recentsRaw));
      expect(recentsParsed.entries).toHaveLength(1);
      const head = recentsParsed.entries[0];
      expect(head?.projectId).toBe(projectId);
      expect(head?.folderPath).toBe("/Project Foo");
      expect(head?.role).toBe("originator");
      expect(head?.available).toBe(true);
      expect(head?.unavailableReason).toBeNull();
    });

    it("returns an error and writes nothing when the chosen folder has no .md files", async () => {
      env.graphState.driveFolderChildren.set("folder-proj", [
        {
          id: "file-txt",
          name: "notes.txt",
          size: 5,
          lastModifiedDateTime: "2026-04-19T05:00:00Z",
          file: { mimeType: "text/plain" },
          content: "hi",
        },
      ]);
      const { spy } = pickerSpy("folder-proj", "/Project Foo");
      const auth = new MockAuthenticator({ token: "init-token" });
      const c = await createTestClient(env, auth, { openBrowser: spy });

      const result = (await c.callTool({
        name: "session_init_project",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("contains no markdown");

      // No .collab folder created because the validation refused before
      // reaching the create-folder step.
      const projectChildren = env.graphState.driveFolderChildren.get("folder-proj") ?? [];
      expect(projectChildren.find((c) => c.name === ".collab")).toBeUndefined();
    });

    it("refuses to overwrite an already-initialised project", async () => {
      // Pre-seed a .collab/ subfolder so the init flow detects the collision.
      env.graphState.driveFolderChildren.get("folder-proj")?.push({
        id: "collab-existing",
        name: ".collab",
        folder: { childCount: 1 },
        lastModifiedDateTime: "2026-04-19T04:00:00Z",
      });
      env.graphState.driveFolderChildren.set("collab-existing", []);

      const { spy } = pickerSpy("folder-proj", "/Project Foo");
      const auth = new MockAuthenticator({ token: "init-token" });
      const c = await createTestClient(env, auth, { openBrowser: spy });

      const result = (await c.callTool({
        name: "session_init_project",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("already contains a .collab/ subfolder");
    });
  });

  // -------------------------------------------------------------------------
  // Downstream collab_write / collab_read / collab_list_files
  // (lands in W2 Day 4 + W3 Day 2)
  // -------------------------------------------------------------------------

  it.todo(
    "after the §3.6 audit writer lands (W3 Day 3): writing the authoritative file appends an audit entry",
  );

  describe("collab_read + collab_list_files (W2 Day 4)", () => {
    it("reading echoes the written body with cTag, listing surfaces the authoritative file marker", async () => {
      // First, initialize the project
      const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
      const auth = new MockAuthenticator({
        token: "init-token",
        username: "alice@example.com",
      });
      const c = await createTestClient(env, auth, { openBrowser: spy });

      const initResult = (await c.callTool({
        name: "session_init_project",
        arguments: {},
      })) as ToolResult;
      expect(initResult.isError).toBeFalsy();

      // Seed the authoritative file with frontmatter for the read test
      const authoritativeContent = `---
collab:
  version: 1
  doc_id: "01JTEST0000000000000000000"
  created_at: "2026-04-19T05:00:00Z"
  sections: []
  proposals: []
  authorship: []
---
# Spec Document

This is the body content.
`;
      const specFile = env.graphState.driveFolderChildren
        .get("folder-proj")
        ?.find((f) => f.id === "file-spec");
      if (specFile) {
        specFile.content = authoritativeContent;
        specFile.size = Buffer.byteLength(authoritativeContent, "utf-8");
      }

      // Test collab_read for the authoritative file
      const readResult = (await c.callTool({
        name: "collab_read",
        arguments: { path: "spec.md" },
      })) as ToolResult;
      expect(readResult.isError).toBeFalsy();
      const readText = firstText(readResult);
      expect(readText).toContain("file: spec.md (file-spec)");
      expect(readText).toContain("isAuthoritative: true");
      expect(readText).toContain("---FRONTMATTER (parsed)---");
      expect(readText).toContain("doc_id");
      expect(readText).toContain("01JTEST0000000000000000000");
      expect(readText).toContain("---BODY---");
      expect(readText).toContain("This is the body content.");

      // Test collab_list_files
      const listResult = (await c.callTool({
        name: "collab_list_files",
        arguments: {},
      })) as ToolResult;
      expect(listResult.isError).toBeFalsy();
      const listText = firstText(listResult);
      expect(listText).toContain("ROOT");
      expect(listText).toContain("spec.md");
      expect(listText).toContain("[authoritative]");
      // .collab folder should NOT appear in listing
      expect(listText).not.toContain(".collab");
    });
  });

  // -------------------------------------------------------------------------
  // collab_write (W3 Day 2)
  // -------------------------------------------------------------------------

  describe("collab_write (W3 Day 2)", () => {
    it("writing the authoritative file injects frontmatter doc_id and bumps cTag", async () => {
      const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
      const auth = new MockAuthenticator({
        token: "init-token",
        username: "alice@example.com",
      });
      const c = await createTestClient(env, auth, { openBrowser: spy });

      const initResult = (await c.callTool({
        name: "session_init_project",
        arguments: {},
      })) as ToolResult;
      expect(initResult.isError).toBeFalsy();

      // Read the current cTag of the authoritative file.
      const readResult = (await c.callTool({
        name: "collab_read",
        arguments: { path: "spec.md" },
      })) as ToolResult;
      expect(readResult.isError).toBeFalsy();
      const readText = firstText(readResult);
      const cTagMatch = /cTag: (\S+)/.exec(readText);
      const initialCTag = cTagMatch?.[1];
      expect(initialCTag).toBeDefined();
      expect(initialCTag).not.toBe("unknown");

      // Write replacement content WITHOUT frontmatter — the tool must
      // mint and inject a fresh canonical frontmatter block.
      const writeResult = (await c.callTool({
        name: "collab_write",
        arguments: {
          path: "spec.md",
          content: "# Updated Spec\n\nNew body content.\n",
          cTag: initialCTag,
          source: "chat",
        },
      })) as ToolResult;
      expect(writeResult.isError).toBeFalsy();
      const writeText = firstText(writeResult);
      expect(writeText).toContain("wrote: spec.md");
      expect(writeText).toContain("isAuthoritative: true");
      expect(writeText).toContain("kind: replaced");
      expect(writeText).toContain("source: chat");
      expect(writeText).toContain("writes: 1 / 50");
      expect(writeText).toContain("source counters: chat=1");

      // Inspect the live file content directly: must have a valid
      // frontmatter envelope with a fresh doc_id and the new body.
      const specFile = env.graphState.driveFolderChildren
        .get("folder-proj")
        ?.find((f) => f.id === "file-spec");
      expect(specFile?.content).toMatch(/^---\n/);
      expect(specFile?.content).toMatch(/doc_id: "[0-9A-HJKMNP-TV-Z]{26}"/);
      expect(specFile?.content).toContain("# Updated Spec");
      expect(specFile?.content).toContain("New body content.");
      // cTag has been bumped.
      expect(specFile?.cTag).not.toBe(initialCTag);

      // Re-reading exposes the freshly minted doc_id and the new cTag.
      const reread = (await c.callTool({
        name: "collab_read",
        arguments: { path: "spec.md" },
      })) as ToolResult;
      const rereadText = firstText(reread);
      expect(rereadText).toContain("isAuthoritative: true");
      expect(rereadText).toContain("doc_id");
      expect(rereadText).toMatch(/cTag: (?!unknown).+/);
    });

    it("returns CollabCTagMismatchError when the supplied cTag is stale", async () => {
      const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
      const auth = new MockAuthenticator({ token: "init-token" });
      const c = await createTestClient(env, auth, { openBrowser: spy });

      await c.callTool({ name: "session_init_project", arguments: {} });

      const writeResult = (await c.callTool({
        name: "collab_write",
        arguments: {
          path: "spec.md",
          content: "# Updated\n",
          cTag: '"{00000000-0000-0000-0000-000000000000,1}"',
          source: "chat",
        },
      })) as ToolResult;
      expect(writeResult.isError).toBe(true);
      const text = firstText(writeResult);
      expect(text).toContain("cTag mismatch");
      // No write was issued — file content unchanged.
      const specFile = env.graphState.driveFolderChildren
        .get("folder-proj")
        ?.find((f) => f.id === "file-spec");
      expect(specFile?.content).toBe("# spec\n");
    });

    it("creates a non-authoritative file with byPath when no cTag is supplied", async () => {
      const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
      const auth = new MockAuthenticator({ token: "init-token" });
      const c = await createTestClient(env, auth, { openBrowser: spy });

      await c.callTool({ name: "session_init_project", arguments: {} });

      const writeResult = (await c.callTool({
        name: "collab_write",
        arguments: {
          path: "drafts/scratch.md",
          content: "# Scratch\n",
          source: "chat",
        },
      })) as ToolResult;
      expect(writeResult.isError).toBeFalsy();
      const text = firstText(writeResult);
      expect(text).toContain("wrote: scratch.md");
      expect(text).toContain("kind: created");
      expect(text).toContain("isAuthoritative: false");

      // The drafts/ folder was lazily created and contains scratch.md.
      const projectChildren = env.graphState.driveFolderChildren.get("folder-proj") ?? [];
      const draftsFolder = projectChildren.find((c) => c.name === "drafts");
      expect(draftsFolder).toBeDefined();
      const draftsChildren = env.graphState.driveFolderChildren.get(draftsFolder?.id ?? "") ?? [];
      const scratch = draftsChildren.find((c) => c.name === "scratch.md");
      expect(scratch).toBeDefined();
      expect(scratch?.content).toBe("# Scratch\n");
    });
  });
});
