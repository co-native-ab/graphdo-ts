// Integration test #05: source: "external" re-approval (collab v1 §10).
//
// W3 Day 2 lights this row up. `collab_write` with `source: "external"`
// must open a browser re-approval form before any Graph write is
// issued. Approve → write completes; cancel → ExternalSourceDeclinedError
// and the file is not modified.
//
// The form-factory slot (§5.3) must be released on every terminal
// outcome — the second test in this file would deadlock if the slot
// leaked from the first.
//
// The §3.6 audit envelope (`external_source_approval`) lands with the
// W3 Day 3 audit writer; this test asserts only the user-visible
// behaviour for now.

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
import { resetFormFactoryForTest, getActiveFormSlotForTest } from "../../src/tools/collab-forms.js";

let env: IntegrationEnv;

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

/**
 * Browser spy that drives the init pickers (folder + file). Stops
 * responding after the second open so the third call (the external
 * re-prompt) is left for the test to drive directly via fetch.
 */
function initPickerSpyThenCapture(
  folderId: string,
  folderLabel: string,
  fileId: string,
  fileLabel: string,
): { spy: (url: string) => Promise<void>; lastUrl: { url: string }; calls: number[] } {
  const lastUrl = { url: "" };
  const calls: number[] = [];
  let call = 0;
  const spy = (url: string): Promise<void> => {
    lastUrl.url = url;
    const which = call++;
    calls.push(which);
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
        // Subsequent opens (the external re-prompt) are driven by the
        // test directly so it can choose to approve or cancel.
      })();
    }, 50);
    return Promise.resolve();
  };
  return { spy, lastUrl, calls };
}

async function approveExternalReprompt(url: string): Promise<void> {
  const csrfToken = await fetchCsrfToken(url);
  await fetch(`${url}/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "approve", label: "Approve external-source write", csrfToken }),
  });
}

async function cancelExternalReprompt(url: string): Promise<void> {
  const csrfToken = await fetchCsrfToken(url);
  await fetch(`${url}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csrfToken }),
  });
}

describe("05-source-external-reapproval", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedSingleMarkdownFolder(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  it("source='external' with Approve completes the write", async () => {
    const { spy, lastUrl } = initPickerSpyThenCapture(
      "folder-proj",
      "/Project Foo",
      "file-spec",
      "spec.md",
    );
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    await c.callTool({ name: "session_init_project", arguments: {} });

    // Re-read to capture the cTag.
    const readResult = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const initialCTag = /cTag: (\S+)/.exec(firstText(readResult))?.[1];
    expect(initialCTag).toBeDefined();

    // Fire collab_write with source='external'. The tool will block on
    // the browser re-approval; we resolve the form by POST-ing approve
    // to the captured URL.
    const writePromise = c.callTool({
      name: "collab_write",
      arguments: {
        path: "spec.md",
        content: "# Approved external content\n\nFrom outside this chat.\n",
        cTag: initialCTag,
        source: "external",
        intent: "Pulled from a vendor docs page",
      },
    });

    // Wait briefly for the form to open and lastUrl.url to update.
    let attempts = 0;
    while (
      (!lastUrl.url || getActiveFormSlotForTest()?.kind !== "collab_write_external") &&
      attempts < 50
    ) {
      await new Promise((r) => setTimeout(r, 25));
      attempts++;
    }
    expect(getActiveFormSlotForTest()?.kind).toBe("collab_write_external");
    await approveExternalReprompt(lastUrl.url);

    const writeResult = (await writePromise) as ToolResult;
    expect(writeResult.isError).toBeFalsy();
    const text = firstText(writeResult);
    expect(text).toContain("source: external");
    expect(text).toContain("source counters: chat=0 project=0 external=1");

    // File now contains the approved content (with frontmatter injected).
    const specFile = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    expect(specFile?.content).toContain("Approved external content");
    expect(specFile?.content).toContain("From outside this chat.");

    // Form-factory slot was released.
    expect(getActiveFormSlotForTest()).toBeUndefined();
  });

  it("source='external' with Cancel returns ExternalSourceDeclinedError and writes nothing", async () => {
    const { spy, lastUrl } = initPickerSpyThenCapture(
      "folder-proj",
      "/Project Foo",
      "file-spec",
      "spec.md",
    );
    const auth = new MockAuthenticator({ token: "init-token" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    await c.callTool({ name: "session_init_project", arguments: {} });

    const readResult = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const initialCTag = /cTag: (\S+)/.exec(firstText(readResult))?.[1];

    const writePromise = c.callTool({
      name: "collab_write",
      arguments: {
        path: "spec.md",
        content: "# Should not land\n",
        cTag: initialCTag,
        source: "external",
      },
    });

    let attempts = 0;
    while (
      (!lastUrl.url || getActiveFormSlotForTest()?.kind !== "collab_write_external") &&
      attempts < 50
    ) {
      await new Promise((r) => setTimeout(r, 25));
      attempts++;
    }
    expect(getActiveFormSlotForTest()?.kind).toBe("collab_write_external");
    await cancelExternalReprompt(lastUrl.url);

    const writeResult = (await writePromise) as ToolResult;
    expect(writeResult.isError).toBe(true);
    expect(firstText(writeResult)).toContain("declined");

    // File content unchanged.
    const specFile = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    expect(specFile?.content).toBe("# spec\n");

    // No write-budget consumption on decline.
    const status = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(firstText(status)).toContain("writes: 0 / 50");

    // Slot released on cancel.
    expect(getActiveFormSlotForTest()).toBeUndefined();
  });
});
