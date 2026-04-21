// Integration test #23 — `session_open_project` URL-paste entry point.
//
// Mirrors the scenario the two-instance E2E playbook (S2 in
// `docs/plans/two-instance-e2e.md`) exercises on a single Microsoft
// account: Alice initialises a project; Bob — same Microsoft user, fresh
// configDir, distinct persona — joins by pasting the OneDrive folder
// share link. Bob's recents are empty; the URL-paste form is the only
// path open to him.
//
// What this test guards against: the W4-Day-4 stub in
// `src/tools/session-open.ts` previously rendered no clickable options
// on a fresh configDir, so the form looked empty and the only way to
// continue was Cancel. Wiring `onShareUrl` into the picker (and into
// the picker template via the new top-level `shareUrlEnabled` flag)
// gives Bob a paste box that resolves the share link via
// `/shares/{encoded}/driveItem` and selects the resolved folder
// directly — same code path the recents row would take, just with a
// raw folder id instead of `recent:<projectId>:<folderId>`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

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
import type { AgentPersona } from "../../src/persona.js";
import { encodeShareUrl } from "../../src/collab/share-url.js";
import type { DriveItem } from "../../src/graph/types.js";

let env: IntegrationEnv;
let bobConfigDir: string;

const ALICE_PERSONA: AgentPersona = {
  id: "persona:alice",
  rawEnvValue: "persona:alice",
  source: "env",
};
const BOB_PERSONA: AgentPersona = {
  id: "persona:bob",
  rawEnvValue: "persona:bob",
  source: "env",
};

const SHARE_URL =
  "https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents/Project%20Foo";

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

/**
 * Bob's openBrowser spy: instead of clicking a recents row (he has
 * none), POST the shared URL to `/share-url`. The picker server's
 * `onShareUrl` callback resolves it via `/shares/...` and selects the
 * folder directly (no second POST needed).
 */
function pickerSpyShareUrl(shareUrl: string): (url: string) => Promise<void> {
  return (url: string): Promise<void> => {
    setTimeout(() => {
      void (async () => {
        // First fetch the page so the test can also assert the form
        // rendered (regression guard for the empty-form bug).
        const html = await (await fetch(url)).text();
        if (!html.includes("share-url-input")) {
          throw new Error("share-url form missing from picker HTML");
        }
        const csrfToken = await fetchCsrfToken(url);
        await fetch(`${url}/share-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: shareUrl, csrfToken }),
        });
      })();
    }, 150);
    return Promise.resolve();
  };
}

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
      size: 64,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "# Introduction\n\nIntro body.\n",
    },
  ]);
  env.graphState.permissions?.set("folder-proj", [{ id: "perm-1", roles: ["write"] }]);

  // Seed the share-id → DriveItem mapping the mock graph uses to
  // service `GET /shares/{encoded}/driveItem`. Bob's tool computes
  // the encoded id from `SHARE_URL` and looks it up here.
  const shareItem: DriveItem = {
    id: "folder-proj",
    name: "Project Foo",
    folder: {},
    lastModifiedDateTime: "2026-04-19T05:00:00Z",
    parentReference: {
      driveId: "mock-drive-1",
      path: "/drives/mock-drive-1/root:",
    },
  };
  env.graphState.shares?.set(encodeShareUrl(SHARE_URL), shareItem);
}

describe("23-session-open-share-url (URL-paste entry point on a fresh configDir)", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedProject(env);
    bobConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-bob-share-url-"));
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
    await rm(bobConfigDir, { recursive: true, force: true });
  });

  it("Bob joins Alice's project via URL paste (no recents pre-seed)", async () => {
    const sharedAuth = new MockAuthenticator({
      token: "shared-token",
      username: "shared@example.com",
    });

    // ---- Alice (originator) ----
    const aliceClient = await createTestClient(env, sharedAuth, {
      openBrowser: pickerSpyTwoStep("folder-proj", "/Project Foo", "file-spec", "spec.md"),
      agentPersona: ALICE_PERSONA,
    });

    const aliceInit = (await aliceClient.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(aliceInit.isError).toBeFalsy();
    const aliceInitText = firstText(aliceInit);
    const projectIdMatch = /projectId: (\S+)/.exec(aliceInitText);
    const projectId = projectIdMatch?.[1] ?? "";
    expect(projectId.length).toBeGreaterThan(0);

    // ---- Bob (collaborator, fresh configDir, NO recents) ----
    // The only entry point available to him is the URL-paste box. The
    // spy validates that the form is rendered (HTML contains the
    // share-url input), then POSTs the share URL.
    const bobClient = await createTestClient(env, sharedAuth, {
      openBrowser: pickerSpyShareUrl(SHARE_URL),
      agentPersona: BOB_PERSONA,
      configDir: bobConfigDir,
    });

    const bobOpen = (await bobClient.callTool({
      name: "session_open_project",
      arguments: {},
    })) as ToolResult;
    expect(bobOpen.isError).toBeFalsy();
    const bobOpenText = firstText(bobOpen);
    expect(bobOpenText).toContain("Collab session opened successfully");
    expect(bobOpenText).toContain(`Project: ${projectId}`);
    expect(bobOpenText).toContain("Agent ID: persona:bob");
    expect(bobOpenText).toContain("Role: collaborator");

    await aliceClient.close();
    await bobClient.close();
  });
});
