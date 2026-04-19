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
 * Build a browser spy that, on the first call, schedules a POST to
 * `<url>/select` for the supplied folder id. Captures the URL it was
 * given so tests can assert on it.
 */
function pickerSpy(
  folderId: string,
  folderLabel: string,
): {
  spy: (url: string) => Promise<void>;
  captured: { url: string };
} {
  const captured = { url: "" };
  const spy = (url: string): Promise<void> => {
    captured.url = url;
    setTimeout(() => {
      void (async () => {
        const csrfToken = await fetchCsrfToken(url);
        await fetch(`${url}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: folderId, label: folderLabel, csrfToken }),
        });
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
      const { spy, captured } = pickerSpy("folder-proj", "/Project Foo");
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
    "after `collab_write` lands (W3 Day 2): writing the authoritative file injects frontmatter `doc_id`, bumps cTag, appends an audit entry",
  );
  it.todo(
    "after `collab_read` + `collab_list_files` land (W2 Day 4): reading echoes the written body with cTag, listing surfaces the authoritative file marker",
  );
});
