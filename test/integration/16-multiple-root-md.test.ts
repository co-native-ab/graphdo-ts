// Integration test #16 (collab v1 §10): multiple root markdown handling.
//
// Status: W1 Day 4 — both N=1 and N=3 variants exercise the second
// browser picker that `session_init_project` opens to select the
// authoritative `.md` file from the chosen folder's root.
//
// Per `docs/plans/collab-v1.md` §10:
//
//   - **N=1 variant:** init folder with single root `.md` `spec.md` —
//     form pre-selects it; spy submits without changing selection;
//     sentinel records `spec.md`.
//
//   - **N=3 variant:** folder with `README.md`, `NOTES.md`, `spec.md`
//     — form has no default; spy attempts submit with no selection
//     (rejected client-side); spy then selects `spec.md` and submits;
//     sentinel records `spec.md`; the other two remain unmodified and
//     are visible in `collab_list_files` ROOT group as ordinary
//     entries. (Reading the ROOT group lands with `collab_list_files`
//     in W2 Day 4 — until then we assert the underlying mock-Graph
//     state directly: README.md and NOTES.md are still children of the
//     project folder, untouched.)

import { describe, it, expect, beforeEach, afterEach } from "vitest";

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
import { resetFormFactoryForTest } from "../../src/tools/collab-forms.js";

let env: IntegrationEnv;

interface PickerStep {
  /**
   * id to POST to the picker. `null` simulates a "submit with no
   * selection" attempt (forged POST with an empty id).
   */
  id: string | null;
  /** Optional label submitted with the id (only used when `id !== null`). */
  label?: string;
  /**
   * When true, the spy expects this POST to be rejected by the picker
   * (option-set / empty-id check) and then continues to the *next*
   * step against the same picker URL. The HTTP status of the rejection
   * is captured on `captured.rejections` so tests can assert on it.
   *
   * `null` ids are always treated as rejected (the picker returns 400
   * for `id: ""`); this flag is what lets a non-null id (e.g. a
   * smuggled foreign drive item) also be marked as a rejection step.
   */
  expectRejection?: boolean;
}

/**
 * Browser spy that walks a sequence of pickers in order. Each entry in
 * `steps` corresponds to one submit attempt against a picker URL.
 *
 * Steps without `expectRejection` (and not `id: null`) advance the spy
 * to the *next* picker URL when `openBrowser` is called again. Steps
 * with `expectRejection: true` (or `id: null`, which is implicitly a
 * rejection) keep the same picker URL and immediately fire the next
 * step against it.
 *
 * `captured.urls` lists every picker URL the spy was given.
 * `captured.rejections` lists `{ status, body }` for every rejected
 * POST so tests can assert the picker actually refused the smuggle.
 */
function chainedPickerSpy(steps: PickerStep[]): {
  spy: (url: string) => Promise<void>;
  captured: { urls: string[]; rejections: { status: number; body: string }[] };
} {
  const captured = {
    urls: [] as string[],
    rejections: [] as { status: number; body: string }[],
  };
  let stepIndex = 0;

  async function postSelection(
    url: string,
    csrfToken: string,
    step: PickerStep,
  ): Promise<Response> {
    return await fetch(`${url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: step.id ?? "",
        label: step.label ?? step.id ?? "",
        csrfToken,
      }),
    });
  }

  async function runStepsForUrl(url: string): Promise<void> {
    const csrfToken = await fetchCsrfToken(url);
    // Drive consecutive steps that target the same picker URL — every
    // rejection step is followed by another submit against the same URL
    // until a non-rejection step advances us off this picker.
    let step = steps[stepIndex++];
    while (step) {
      const isRejection = step.expectRejection === true || step.id === null;
      const response = await postSelection(url, csrfToken, step);
      if (isRejection) {
        if (response.ok) {
          throw new Error(
            `expected /select to reject id=${String(step.id)} but got ${String(response.status)}`,
          );
        }
        captured.rejections.push({
          status: response.status,
          body: await response.text(),
        });
        step = steps[stepIndex++];
        continue;
      }
      // Non-rejection submit — the picker server will close after this
      // resolves; the next openBrowser call (if any) corresponds to the
      // next picker.
      return;
    }
  }

  const spy = (url: string): Promise<void> => {
    captured.urls.push(url);
    setTimeout(() => {
      void runStepsForUrl(url);
    }, 150);
    return Promise.resolve();
  };
  return { spy, captured };
}

function seedProjectFolder(env: IntegrationEnv, files: { id: string; name: string }[]): void {
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
  env.graphState.driveFolderChildren.set(
    "folder-proj",
    files.map((f) => ({
      id: f.id,
      name: f.name,
      size: 16,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content: `# ${f.name}\n`,
    })),
  );
}

describe("16-multiple-root-md", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  describe("N=1: single root .md (form pre-selects)", () => {
    it("opens the file picker, spy confirms the only option, sentinel records spec.md", async () => {
      seedProjectFolder(env, [{ id: "file-spec", name: "spec.md" }]);

      const { spy, captured } = chainedPickerSpy([
        { id: "folder-proj", label: "/Project Foo" },
        // N=1 confirmation: spy submits the one option without changing it.
        { id: "file-spec", label: "spec.md" },
      ]);
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
      expect(text).toContain("authoritativeFile: spec.md (file-spec)");
      // Two browser windows were opened in succession (folder, then file).
      expect(captured.urls).toHaveLength(2);
      expect(captured.urls[0]).not.toBe(captured.urls[1]);

      const projectChildren = env.graphState.driveFolderChildren.get("folder-proj") ?? [];
      const collabFolder = projectChildren.find((cn) => cn.name === ".collab");
      expect(collabFolder).toBeDefined();
      const collabChildren = env.graphState.driveFolderChildren.get(collabFolder?.id ?? "") ?? [];
      const sentinelFile = collabChildren.find((cn) => cn.name === "project.json");
      expect(sentinelFile).toBeDefined();
      const sentinelDoc = JSON.parse(sentinelFile?.content ?? "") as Record<string, unknown>;
      expect(sentinelDoc["authoritativeFileId"]).toBe("file-spec");
      expect(sentinelDoc["authoritativeFileName"]).toBe("spec.md");
    });
  });

  describe("N=3: README.md + NOTES.md + spec.md", () => {
    it("rejects empty submit, then records spec.md while leaving the other two untouched", async () => {
      seedProjectFolder(env, [
        { id: "file-readme", name: "README.md" },
        { id: "file-notes", name: "NOTES.md" },
        { id: "file-spec", name: "spec.md" },
      ]);

      const { spy, captured } = chainedPickerSpy([
        { id: "folder-proj", label: "/Project Foo" },
        // First sub-step on the file picker: empty submit (rejected
        // client-side / by the picker server's option-set check).
        { id: null },
        // Second sub-step: the real selection. The chained spy POSTs
        // both against the same picker URL.
        { id: "file-spec", label: "spec.md" },
      ]);
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
      expect(text).toContain("authoritativeFile: spec.md (file-spec)");

      // The folder picker + file picker each opened a separate
      // loopback URL (one openBrowser call per picker).
      expect(captured.urls).toHaveLength(2);
      // The empty-id submit was rejected by the picker's option-set
      // check before the real selection landed.
      expect(captured.rejections).toHaveLength(1);
      expect(captured.rejections[0]?.status).toBe(400);

      const projectChildren = env.graphState.driveFolderChildren.get("folder-proj") ?? [];

      // Sibling .md files are still present and untouched (same id +
      // original content). collab_list_files lands in W2 Day 4 — until
      // then we assert the underlying mock-Graph state directly.
      const readme = projectChildren.find((cn) => cn.id === "file-readme");
      const notes = projectChildren.find((cn) => cn.id === "file-notes");
      expect(readme?.name).toBe("README.md");
      expect(notes?.name).toBe("NOTES.md");
      expect(readme?.content).toBe("# README.md\n");
      expect(notes?.content).toBe("# NOTES.md\n");

      // Sentinel records spec.md as the authoritative file.
      const collabFolder = projectChildren.find((cn) => cn.name === ".collab");
      expect(collabFolder).toBeDefined();
      const collabChildren = env.graphState.driveFolderChildren.get(collabFolder?.id ?? "") ?? [];
      const sentinelFile = collabChildren.find((cn) => cn.name === "project.json");
      const sentinelDoc = JSON.parse(sentinelFile?.content ?? "") as Record<string, unknown>;
      expect(sentinelDoc["authoritativeFileId"]).toBe("file-spec");
      expect(sentinelDoc["authoritativeFileName"]).toBe("spec.md");
    });

    it("validates the file selection against the option set (cannot smuggle a different drive item id)", async () => {
      seedProjectFolder(env, [
        { id: "file-readme", name: "README.md" },
        { id: "file-notes", name: "NOTES.md" },
        { id: "file-spec", name: "spec.md" },
      ]);
      // Add an unrelated drive item that is *not* a root .md of the
      // project folder. The spy will try to submit its id to the file
      // picker; the picker's option-set check must reject it as
      // `Invalid selection` (no Graph write happens).
      env.graphState.driveRootChildren.push({
        id: "file-elsewhere",
        name: "elsewhere.md",
        size: 1,
        lastModifiedDateTime: "2026-04-19T05:00:00Z",
        file: { mimeType: "text/markdown" },
      });

      const { spy, captured } = chainedPickerSpy([
        { id: "folder-proj", label: "/Project Foo" },
        // Smuggled id (a real drive item id — `file-elsewhere` — but
        // *not* part of the file-picker's option set). The picker's
        // option-set check must reject this; the spy then submits the
        // real selection on the same picker URL.
        { id: "file-elsewhere", label: "elsewhere.md", expectRejection: true },
        { id: "file-spec", label: "spec.md" },
      ]);
      const auth = new MockAuthenticator({ token: "init-token" });
      const c = await createTestClient(env, auth, { openBrowser: spy });

      const result = (await c.callTool({
        name: "session_init_project",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();

      // The picker actually rejected the smuggled id — assert the
      // observed status + body (defence in depth: ensures the test
      // exercised the option-set check, not just the unrelated success
      // of the legitimate selection).
      expect(captured.rejections).toHaveLength(1);
      expect(captured.rejections[0]?.status).toBe(400);
      expect(captured.rejections[0]?.body).toContain("Invalid selection");

      const projectChildren = env.graphState.driveFolderChildren.get("folder-proj") ?? [];
      const collabFolder = projectChildren.find((cn) => cn.name === ".collab");
      const collabChildren = env.graphState.driveFolderChildren.get(collabFolder?.id ?? "") ?? [];
      const sentinelFile = collabChildren.find((cn) => cn.name === "project.json");
      const sentinelDoc = JSON.parse(sentinelFile?.content ?? "") as Record<string, unknown>;
      // Sentinel records the legitimately-selected file, never the
      // smuggled id.
      expect(sentinelDoc["authoritativeFileId"]).toBe("file-spec");
    });
  });
});
