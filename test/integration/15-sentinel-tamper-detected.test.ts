// Scenario test #15: sentinel tamper detection (collab v1 §3.2, plan §10).
//
// Three variants of §3.2 are exercised:
//
//   - **Variant A — rename, allowed.** Codec-level, end-to-end through
//     `verifySentinelAgainstPin`. Renaming the authoritative file (which
//     preserves `driveItem.id`) only refreshes the pin's display name.
//   - **Variant B — real tamper.** Full `session_open_project` integration
//     against the in-process MCP server + mock Graph: a tampered sentinel
//     produces a `sentinel_changed` audit entry written *before* the
//     `SentinelTamperedError` is thrown, and "forget project" (clearing
//     local pin metadata) lets a subsequent open re-pin cleanly.
//   - **Variant C — folder moved.** Full `session_open_project` integration
//     showing the silent `folderPath` refresh in both project metadata and
//     recents when the originator moves the project folder in OneDrive.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  SENTINEL_SCHEMA_VERSION,
  parseSentinel,
  serializeSentinel,
  verifySentinelAgainstPin,
  type ProjectSentinel,
  type SentinelPin,
} from "../../src/collab/sentinel.js";
import { SentinelTamperedError } from "../../src/errors.js";
import {
  ProjectMetadataSchema,
  RecentsFileSchema,
  projectMetadataPath,
  recentsPath,
} from "../../src/collab/projects.js";
import { resetFormFactoryForTest } from "../../src/tools/collab-forms.js";

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

/**
 * Imitate `session_init_project`'s sentinel write + first
 * `session_open_project`'s pin recording, without depending on either
 * tool (neither exists yet). We round-trip the sentinel through the
 * codec so the test exercises the same JSON path the live Graph
 * `readSentinel` will use once W4 Day 4 lands.
 */
function openProjectFirstTime(initial: ProjectSentinel): {
  pin: SentinelPin;
  sentinelOnDisk: string;
  pinnedAt: string;
} {
  const sentinelOnDisk = serializeSentinel(initial);
  const pinnedAt = "2026-04-19T05:00:00Z";
  const pin: SentinelPin = {
    pinnedAuthoritativeFileId: initial.authoritativeFileId,
    pinnedSentinelFirstSeenAt: pinnedAt,
    pinnedAtFirstSeenCTag: '"c:{sentinel-1},1"',
    displayAuthoritativeFileName: initial.authoritativeFileName,
  };
  return { pin, sentinelOnDisk, pinnedAt };
}

describe("15-sentinel-tamper-detected", () => {
  const initial: ProjectSentinel = {
    schemaVersion: SENTINEL_SCHEMA_VERSION,
    projectId: "01JABCDE0FGHJKMNPQRSTV0WXY",
    authoritativeFileId: "01AUTHFILE0001",
    authoritativeFileName: "spec.md",
    createdBy: { displayName: "Alice" },
    createdAt: "2026-04-19T05:00:00Z",
  };

  describe("Variant A — rename, allowed", () => {
    it("re-open after originator renames spec.md → README.md succeeds and refreshes the display name", () => {
      const { pin, sentinelOnDisk } = openProjectFirstTime(initial);

      // Originator renames the authoritative file in OneDrive web. The
      // sentinel's `authoritativeFileName` is rewritten by some other
      // tooling (or the originator manually re-uploads) but the
      // `authoritativeFileId` is unchanged because OneDrive preserves
      // `driveItem.id` across renames.
      const renamedOnDisk = serializeSentinel({
        ...parseSentinel(sentinelOnDisk),
        authoritativeFileName: "README.md",
      });

      const liveSentinel = parseSentinel(renamedOnDisk);
      const result = verifySentinelAgainstPin(liveSentinel, pin);

      expect(result).toEqual({
        kind: "renamed",
        refreshedDisplayAuthoritativeFileName: "README.md",
      });
      // Pin's `pinnedAuthoritativeFileId` is unchanged — the pin remains
      // valid; only the display-name field is refreshed by the caller.
      expect(pin.pinnedAuthoritativeFileId).toBe("01AUTHFILE0001");
    });

    it("a no-op re-open (sentinel unchanged) reports a plain match", () => {
      const { pin, sentinelOnDisk } = openProjectFirstTime(initial);
      const result = verifySentinelAgainstPin(parseSentinel(sentinelOnDisk), pin);
      expect(result).toEqual({ kind: "match" });
    });
  });

  describe("Variant B — real tamper", () => {
    // The codec-level shape of the tamper detection is verified here
    // (defence-in-depth — guards against accidentally weakening the
    // comparator). The full `session_open_project` integration row
    // for both Variant B (tamper) and Variant C (folder moved) lives
    // in the `session_open_project integration` block below.
    it("re-open after authoritativeFileId is swapped raises SentinelTamperedError (codec)", () => {
      const { pin, sentinelOnDisk, pinnedAt } = openProjectFirstTime(initial);

      const tamperedOnDisk = serializeSentinel({
        ...parseSentinel(sentinelOnDisk),
        authoritativeFileId: "01MALICIOUS9999",
      });

      try {
        verifySentinelAgainstPin(parseSentinel(tamperedOnDisk), pin);
        throw new Error("expected SentinelTamperedError");
      } catch (err) {
        expect(err).toBeInstanceOf(SentinelTamperedError);
        const e = err as SentinelTamperedError;
        expect(e.pinnedAuthoritativeFileId).toBe("01AUTHFILE0001");
        expect(e.currentAuthoritativeFileId).toBe("01MALICIOUS9999");
        expect(e.pinnedSentinelFirstSeenAt).toBe(pinnedAt);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // session_open_project integration (Variants B + C end-to-end)
  // ---------------------------------------------------------------------------

  describe("session_open_project integration", () => {
    let env: IntegrationEnv;

    beforeEach(async () => {
      resetFormFactoryForTest();
      env = await setupIntegrationEnv();
      seedProject(env);
    });

    afterEach(async () => {
      resetFormFactoryForTest();
      await teardownIntegrationEnv(env);
    });

    it("Variant B: tampered sentinel writes a sentinel_changed audit entry before throwing; forgetting the pin lets a subsequent open re-pin cleanly", async () => {
      // ---- Originator initialises the project ----
      const initClient = await createTestClient(env, makeAuth(), {
        openBrowser: pickerSpyTwoStep("folder-proj", "/Project Foo", "file-spec", "spec.md"),
      });
      const initResult = (await initClient.callTool({
        name: "session_init_project",
        arguments: {},
      })) as ToolResult;
      expect(initResult.isError).toBeFalsy();
      const projectId = projectIdFromInit(firstText(initResult));

      // The pin's authoritativeFileId was recorded as `file-spec`.
      const metaPathStr = projectMetadataPath(env.configDir, projectId);
      const metaBefore = ProjectMetadataSchema.parse(
        JSON.parse(await readFile(metaPathStr, "utf-8")),
      );
      expect(metaBefore.pinnedAuthoritativeFileId).toBe("file-spec");
      const pinnedCTagBefore = metaBefore.pinnedAtFirstSeenCTag;

      // ---- Tamper the sentinel on disk in OneDrive ----
      // Swap `authoritativeFileId` to the secondary file the seed planted
      // alongside `spec.md`. The malicious file *exists* so the open flow
      // reaches the pin-verification step (an unknown id would short-circuit
      // with `AuthoritativeFileMissingError` before we got there).
      const sentinelFile = findSentinelFile(env);
      const sentinelDoc = JSON.parse(sentinelFile.content ?? "") as Record<string, unknown>;
      sentinelDoc["authoritativeFileId"] = "file-malicious";
      sentinelFile.content = JSON.stringify(sentinelDoc);
      sentinelFile.cTag = `"c:{tampered-${projectId}},2"`;

      // ---- Re-open with a fresh MCP server (new SessionRegistry) ----
      const recentOptionId = `recent:${projectId}:folder-proj`;
      const tamperClient = await createTestClient(env, makeAuth(), {
        openBrowser: pickerSpyOpenProject(recentOptionId, "/Project Foo — spec.md"),
      });
      const tamperResult = (await tamperClient.callTool({
        name: "session_open_project",
        arguments: {},
      })) as ToolResult;
      expect(tamperResult.isError).toBe(true);
      expect(firstText(tamperResult)).toContain("Sentinel tampered");

      // The audit entry must have been written *before* the throw.
      const auditEntries = await readAudit(env.configDir, projectId);
      const tamperEntry = auditEntries.find((e) => e["type"] === "sentinel_changed");
      expect(tamperEntry).toBeDefined();
      expect(tamperEntry?.["tool"]).toBe("session_open_project");
      expect(tamperEntry?.["result"]).toBe("failure");
      expect(tamperEntry?.["projectId"]).toBe(projectId);
      const details = tamperEntry?.["details"] as Record<string, unknown>;
      expect(details["pinnedAuthoritativeFileId"]).toBe("file-spec");
      expect(details["currentAuthoritativeFileId"]).toBe("file-malicious");
      expect(details["pinnedAtFirstSeenCTag"]).toBe(pinnedCTagBefore);
      expect(details["currentSentinelCTag"]).toBe(sentinelFile.cTag);

      // No `session_start` from the failed open: the throw beat the
      // session-activation step.
      const startsAfterTamper = auditEntries.filter((e) => e["type"] === "session_start");
      // Only the originator's init produced a session_start.
      expect(startsAfterTamper.length).toBe(1);

      // The pin on disk is unchanged (the tamper did not rewrite it).
      const metaAfterTamper = ProjectMetadataSchema.parse(
        JSON.parse(await readFile(metaPathStr, "utf-8")),
      );
      expect(metaAfterTamper.pinnedAuthoritativeFileId).toBe("file-spec");
      await tamperClient.close();

      // ---- "Forget project" clears the pin (delete the metadata file) ----
      // There is no dedicated tool for this yet; the §3.2 contract is that
      // removing local pin metadata returns the project to first-open
      // state. The user-facing "Forget project" affordance lands later;
      // until then the file-level invariant is what we guard.
      await rm(metaPathStr);

      // ---- Re-open after forget; tampered sentinel becomes the new pin ----
      const reopenClient = await createTestClient(env, makeAuth(), {
        openBrowser: pickerSpyOpenProject(recentOptionId, "/Project Foo — spec.md"),
      });
      const reopenResult = (await reopenClient.callTool({
        name: "session_open_project",
        arguments: {},
      })) as ToolResult;
      expect(reopenResult.isError).toBeFalsy();
      expect(firstText(reopenResult)).toContain("Collab session opened successfully.");

      const metaAfterReopen = ProjectMetadataSchema.parse(
        JSON.parse(await readFile(metaPathStr, "utf-8")),
      );
      expect(metaAfterReopen.pinnedAuthoritativeFileId).toBe("file-malicious");
      expect(metaAfterReopen.pinnedAtFirstSeenCTag).toBe(sentinelFile.cTag);
      await reopenClient.close();
    });

    it("Variant C: silent folderPath refresh in both project metadata and recents when the project folder is moved", async () => {
      // ---- Originator initialises the project at /Project Foo ----
      const initClient = await createTestClient(env, makeAuth(), {
        openBrowser: pickerSpyTwoStep("folder-proj", "/Project Foo", "file-spec", "spec.md"),
      });
      const initResult = (await initClient.callTool({
        name: "session_init_project",
        arguments: {},
      })) as ToolResult;
      expect(initResult.isError).toBeFalsy();
      const projectId = projectIdFromInit(firstText(initResult));

      const metaPathStr = projectMetadataPath(env.configDir, projectId);
      const recentsPathStr = recentsPath(env.configDir);

      const metaBefore = ProjectMetadataSchema.parse(
        JSON.parse(await readFile(metaPathStr, "utf-8")),
      );
      expect(metaBefore.folderPath).toBe("/Project Foo");
      const recentsBefore = RecentsFileSchema.parse(
        JSON.parse(await readFile(recentsPathStr, "utf-8")),
      );
      expect(recentsBefore.entries[0]?.folderPath).toBe("/Project Foo");
      await initClient.close();

      // ---- Move the project folder to /Archive/Project Foo in OneDrive ----
      // The folder keeps its `id` (that's what makes the pin id-based) but
      // its parentReference now resolves to a different path.
      const root = env.graphState.driveRootChildren;
      const projIdx = root.findIndex((c) => c.id === "folder-proj");
      expect(projIdx).toBeGreaterThanOrEqual(0);
      const proj = root[projIdx]!;
      root.splice(projIdx, 1);
      root.push({
        id: "folder-archive",
        name: "Archive",
        folder: {},
        lastModifiedDateTime: "2026-04-19T06:00:00Z",
      });
      env.graphState.driveFolderChildren.set("folder-archive", [proj]);
      env.graphState.permissions?.set("folder-archive", [{ id: "perm-2", roles: ["write"] }]);

      // ---- Re-open via the recent ----
      const recentOptionId = `recent:${projectId}:folder-proj`;
      const reopenClient = await createTestClient(env, makeAuth(), {
        openBrowser: pickerSpyOpenProject(recentOptionId, "/Project Foo — spec.md"),
      });
      const reopenResult = (await reopenClient.callTool({
        name: "session_open_project",
        arguments: {},
      })) as ToolResult;
      expect(reopenResult.isError).toBeFalsy();
      const reopenText = firstText(reopenResult);
      expect(reopenText).toContain("Folder: /Archive/Project Foo");

      // ---- Metadata + recents both show the refreshed path ----
      const metaAfter = ProjectMetadataSchema.parse(
        JSON.parse(await readFile(metaPathStr, "utf-8")),
      );
      expect(metaAfter.folderPath).toBe("/Archive/Project Foo");
      // Pin (id-based) is unchanged.
      expect(metaAfter.pinnedAuthoritativeFileId).toBe(metaBefore.pinnedAuthoritativeFileId);
      expect(metaAfter.folderId).toBe(metaBefore.folderId);

      const recentsAfter = RecentsFileSchema.parse(
        JSON.parse(await readFile(recentsPathStr, "utf-8")),
      );
      const refreshed = recentsAfter.entries.find((e) => e.projectId === projectId);
      expect(refreshed?.folderPath).toBe("/Archive/Project Foo");
      expect(refreshed?.available).toBe(true);
      expect(refreshed?.unavailableReason).toBeNull();

      // ---- The refresh is silent: no sentinel_changed entry was written ----
      const auditEntries = await readAudit(env.configDir, projectId);
      expect(auditEntries.some((e) => e["type"] === "sentinel_changed")).toBe(false);
      // And exactly one new session_start entry from the re-open.
      const starts = auditEntries.filter((e) => e["type"] === "session_start");
      expect(starts.length).toBe(2);
      await reopenClient.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration-test helpers (Variants B + C)
// ---------------------------------------------------------------------------

function makeAuth(): MockAuthenticator {
  return new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
}

function projectIdFromInit(initText: string): string {
  const match = /projectId: (\S+)/.exec(initText);
  const id = match?.[1] ?? "";
  expect(id.length).toBeGreaterThan(0);
  return id;
}

function findSentinelFile(env: IntegrationEnv): {
  id: string;
  name: string;
  content?: string;
  cTag?: string;
} {
  const projectChildren = env.graphState.driveFolderChildren.get("folder-proj") ?? [];
  const collabFolder = projectChildren.find((c) => c.name === ".collab");
  expect(collabFolder).toBeDefined();
  const collabChildren = env.graphState.driveFolderChildren.get(collabFolder?.id ?? "") ?? [];
  const sentinel = collabChildren.find((c) => c.name === "project.json");
  expect(sentinel).toBeDefined();
  return sentinel as { id: string; name: string; content?: string; cTag?: string };
}

async function readAudit(configDir: string, projectId: string): Promise<Record<string, unknown>[]> {
  const auditPath = path.join(configDir, "sessions", "audit", `${projectId}.jsonl`);
  const raw = await readFile(auditPath, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Seed a project folder with two markdown files: `spec.md` (the
 * authoritative file the originator picks) and `malicious.md` (the
 * decoy a tampered sentinel can swap to without tripping
 * `AuthoritativeFileMissingError`). Grants the test user "write" on
 * the project folder so `session_open_project` clears its pre-flight.
 */
function seedProject(env: IntegrationEnv): void {
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
    {
      id: "file-malicious",
      name: "malicious.md",
      size: 16,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "# malicious\n",
    },
  ]);
  env.graphState.permissions?.set("folder-proj", [{ id: "perm-1", roles: ["write"] }]);
}

function pickerSpyTwoStep(
  folderId: string,
  folderLabel: string,
  fileId: string,
  fileLabel: string,
): (url: string) => Promise<void> {
  let call = 0;
  return (url: string): Promise<void> => {
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
        if (which === 1) {
          await fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: fileId, label: fileLabel, csrfToken }),
          });
        }
      })();
    }, 150);
    return Promise.resolve();
  };
}

function pickerSpyOpenProject(
  recentOptionId: string,
  label: string,
): (url: string) => Promise<void> {
  return (url: string): Promise<void> => {
    setTimeout(() => {
      void (async () => {
        const csrfToken = await fetchCsrfToken(url);
        await fetch(`${url}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: recentOptionId, label, csrfToken }),
        });
      })();
    }, 150);
    return Promise.resolve();
  };
}
