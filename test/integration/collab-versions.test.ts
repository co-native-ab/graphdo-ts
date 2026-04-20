// Integration tests for collab_list_versions + collab_restore_version (W5 Day 1).
//
// Per `docs/plans/collab-v1.md` §2.3 / §3.6 / §5.2:
//
//   - list_versions: read-only, defaults to authoritative file, also
//     accepts path / itemId. No write or destructive cost.
//   - restore_version on a non-authoritative draft: 1 write, no
//     destructive re-prompt, no destructive-budget cost.
//   - restore_version on the authoritative file: cTag pre-flight,
//     destructive re-prompt with diff, audit envelope on approve and
//     decline, write + destructive budget both increment.

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
import { resetFormFactoryForTest, getActiveFormSlotForTest } from "../../src/tools/collab-forms.js";

let env: IntegrationEnv;

function pickerSpyThenCapture(
  folderId: string,
  folderLabel: string,
  fileId: string,
  fileLabel: string,
): { spy: (url: string) => Promise<void>; lastUrl: { url: string } } {
  const lastUrl = { url: "" };
  let call = 0;
  const spy = (url: string): Promise<void> => {
    lastUrl.url = url;
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
        // Subsequent opens (destructive re-prompt) are driven by the
        // test directly so it can choose to approve or cancel.
      })();
    }, 50);
    return Promise.resolve();
  };
  return { spy, lastUrl };
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

async function approveDestructive(url: string): Promise<void> {
  const csrfToken = await fetchCsrfToken(url);
  await fetch(`${url}/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "approve", label: "Approve destructive apply", csrfToken }),
  });
}

async function cancelDestructive(url: string): Promise<void> {
  const csrfToken = await fetchCsrfToken(url);
  await fetch(`${url}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csrfToken }),
  });
}

async function waitForReprompt(lastUrl: { url: string }): Promise<void> {
  let attempts = 0;
  const startUrl = lastUrl.url;
  while (
    (lastUrl.url === "" ||
      lastUrl.url === startUrl ||
      getActiveFormSlotForTest()?.kind !== "collab_apply_proposal_destructive") &&
    attempts < 200
  ) {
    await new Promise((r) => setTimeout(r, 25));
    attempts++;
  }
  expect(getActiveFormSlotForTest()?.kind).toBe("collab_apply_proposal_destructive");
}

async function readAuditEntries(
  env: IntegrationEnv,
  projectId: string,
): Promise<Record<string, unknown>[]> {
  const auditPath = `${env.configDir}/sessions/audit/${projectId}.jsonl`;
  let raw: string;
  try {
    raw = await readFile(auditPath, { encoding: "utf-8" });
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("collab-versions", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedSingleMarkdownFolder(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  // -------------------------------------------------------------------------
  // collab_list_versions
  // -------------------------------------------------------------------------

  it("collab_list_versions defaults to the authoritative file and shows version history", async () => {
    const { spy } = pickerSpyThenCapture("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    await c.callTool({ name: "session_init_project", arguments: {} });

    // Two writes so /versions has at least one historical entry plus
    // the current version.
    const r1 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag1 = /cTag: (\S+)/.exec(firstText(r1))?.[1];
    await c.callTool({
      name: "collab_write",
      arguments: { path: "spec.md", content: "# v1\n", cTag: cTag1, source: "chat" },
    });
    const r2 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag2 = /cTag: (\S+)/.exec(firstText(r2))?.[1];
    await c.callTool({
      name: "collab_write",
      arguments: { path: "spec.md", content: "# v2\n", cTag: cTag2, source: "chat" },
    });

    // Default to authoritative.
    const result = (await c.callTool({
      name: "collab_list_versions",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain("[authoritative]");
    expect(text).toMatch(/Total: \d+ version\(s\)/);
  });

  // -------------------------------------------------------------------------
  // collab_restore_version on a non-authoritative draft
  // -------------------------------------------------------------------------

  it("collab_restore_version on a draft restores without re-prompt and increments only writes", async () => {
    const { spy } = pickerSpyThenCapture("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    await c.callTool({ name: "session_init_project", arguments: {} });

    // Create + update a draft so it has a historical version.
    const create = (await c.callTool({
      name: "collab_write",
      arguments: { path: "drafts/scratch.md", content: "draft v1\n", source: "chat" },
    })) as ToolResult;
    expect(create.isError).toBeFalsy();
    const draftId = /\((mock-\d+)\)/.exec(firstText(create))?.[1] ?? "";
    expect(draftId).not.toBe("");
    const draftCTag = /cTag: (\S+)/.exec(firstText(create))?.[1];
    const update = (await c.callTool({
      name: "collab_write",
      arguments: {
        path: "drafts/scratch.md",
        content: "draft v2\n",
        cTag: draftCTag,
        source: "chat",
      },
    })) as ToolResult;
    expect(update.isError).toBeFalsy();

    // List versions to obtain the historical id.
    const list = (await c.callTool({
      name: "collab_list_versions",
      arguments: { path: "drafts/scratch.md" },
    })) as ToolResult;
    const listText = firstText(list);
    // Historical entry is the one whose content was 'draft v1'.
    // Find any non-current id from the formatted output:
    //   "1. {id} — ..." (newest first; index 1 is current, 2+ are historical)
    const lines = listText.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const historicalId = /\d+\. (\S+) /.exec(lines[1] ?? "")?.[1] ?? "";
    expect(historicalId).not.toBe("");

    const writesBefore = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const writesUsedBefore = parseInt(
      /writes: (\d+)/.exec(firstText(writesBefore))?.[1] ?? "0",
      10,
    );

    const restore = (await c.callTool({
      name: "collab_restore_version",
      arguments: { path: "drafts/scratch.md", versionId: historicalId },
    })) as ToolResult;
    expect(restore.isError).toBeFalsy();
    const restoreText = firstText(restore);
    expect(restoreText).toContain("isAuthoritative: false");

    const statusAfter = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const statusAfterText = firstText(statusAfter);
    const writesUsedAfter = parseInt(/writes: (\d+)/.exec(statusAfterText)?.[1] ?? "0", 10);
    expect(writesUsedAfter).toBe(writesUsedBefore + 1);
    // Destructive count must NOT have moved.
    expect(statusAfterText).toMatch(/destructive approvals: 0 \//);
  });

  // -------------------------------------------------------------------------
  // collab_restore_version on the authoritative file
  // -------------------------------------------------------------------------

  it("collab_restore_version on authoritative requires cTag and triggers destructive re-prompt", async () => {
    const { spy, lastUrl } = pickerSpyThenCapture(
      "folder-proj",
      "/Project Foo",
      "file-spec",
      "spec.md",
    );
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    const projectId = /projectId: (\S+)/.exec(firstText(initResult))?.[1] ?? "";

    // Two writes so the historical entry exists.
    const r1 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag1 = /cTag: (\S+)/.exec(firstText(r1))?.[1];
    await c.callTool({
      name: "collab_write",
      arguments: { path: "spec.md", content: "# v1\n", cTag: cTag1, source: "chat" },
    });
    const r2 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag2 = /cTag: (\S+)/.exec(firstText(r2))?.[1];
    await c.callTool({
      name: "collab_write",
      arguments: { path: "spec.md", content: "# v2\n", cTag: cTag2, source: "chat" },
    });

    // Discover the historical version id.
    const list = (await c.callTool({
      name: "collab_list_versions",
      arguments: {},
    })) as ToolResult;
    const lines = firstText(list)
      .split("\n")
      .filter((l) => /^\d+\. /.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const historicalId = /\d+\. (\S+) /.exec(lines[1] ?? "")?.[1] ?? "";
    expect(historicalId).not.toBe("");

    // Missing cTag rejected up-front.
    const noCtag = (await c.callTool({
      name: "collab_restore_version",
      arguments: { versionId: historicalId },
    })) as ToolResult;
    expect(noCtag.isError).toBe(true);
    expect(firstText(noCtag)).toContain("authoritativeCTag is required");

    // Stale cTag rejected with CollabCTagMismatchError.
    const stale = (await c.callTool({
      name: "collab_restore_version",
      arguments: { versionId: historicalId, authoritativeCTag: "stale-tag" },
    })) as ToolResult;
    expect(stale.isError).toBe(true);
    expect(firstText(stale)).toContain("cTag mismatch");

    // Read live cTag, then drive the destructive re-prompt:
    // cancel first, expect declined audit, no counter change.
    const r3 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const liveCTag = /cTag: (\S+)/.exec(firstText(r3))?.[1] ?? "";

    lastUrl.url = "";
    const declinedPromise = c.callTool({
      name: "collab_restore_version",
      arguments: {
        versionId: historicalId,
        authoritativeCTag: liveCTag,
        intent: "rollback test",
      },
    });
    await waitForReprompt(lastUrl);
    await cancelDestructive(lastUrl.url);
    const declinedResult = (await declinedPromise) as ToolResult;
    expect(declinedResult.isError).toBe(true);
    expect(firstText(declinedResult).toLowerCase()).toContain("declined");

    // Audit declined entry.
    const entries = await readAuditEntries(env, projectId);
    const declined = entries.find(
      (e) =>
        e["type"] === "destructive_approval" &&
        e["tool"] === "collab_restore_version" &&
        (e["details"] as Record<string, unknown>)["outcome"] === "declined",
    );
    expect(declined).toBeDefined();

    // Re-read cTag (unchanged because the restore was declined) then approve.
    const r4 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const liveCTag2 = /cTag: (\S+)/.exec(firstText(r4))?.[1] ?? "";

    const writesBefore = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const writesUsedBefore = parseInt(
      /writes: (\d+)/.exec(firstText(writesBefore))?.[1] ?? "0",
      10,
    );
    const destructiveBefore = parseInt(
      /destructive approvals: (\d+)/.exec(firstText(writesBefore))?.[1] ?? "0",
      10,
    );

    lastUrl.url = "";
    const approvedPromise = c.callTool({
      name: "collab_restore_version",
      arguments: {
        versionId: historicalId,
        authoritativeCTag: liveCTag2,
        intent: "rollback approved",
      },
    });
    await waitForReprompt(lastUrl);
    await approveDestructive(lastUrl.url);
    const approvedResult = (await approvedPromise) as ToolResult;
    expect(approvedResult.isError).toBeFalsy();
    const approvedText = firstText(approvedResult);
    expect(approvedText).toContain("isAuthoritative: true");
    expect(approvedText).toContain(`to versionId: ${historicalId}`);

    const statusAfter = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const statusText = firstText(statusAfter);
    const writesUsedAfter = parseInt(/writes: (\d+)/.exec(statusText)?.[1] ?? "0", 10);
    const destructiveAfter = parseInt(
      /destructive approvals: (\d+)/.exec(statusText)?.[1] ?? "0",
      10,
    );
    expect(writesUsedAfter).toBe(writesUsedBefore + 1);
    expect(destructiveAfter).toBe(destructiveBefore + 1);

    // Audit approved entry + tool_call entry both written.
    const entriesAfter = await readAuditEntries(env, projectId);
    const approvedAudit = entriesAfter.find(
      (e) =>
        e["type"] === "destructive_approval" &&
        e["tool"] === "collab_restore_version" &&
        (e["details"] as Record<string, unknown>)["outcome"] === "approved",
    );
    expect(approvedAudit).toBeDefined();
    const toolCall = entriesAfter.find(
      (e) => e["type"] === "tool_call" && e["tool"] === "collab_restore_version",
    );
    expect(toolCall).toBeDefined();
  });
});
