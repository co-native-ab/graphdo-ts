// Integration tests for `collab_delete_file` (W5 Day 2).
//
// Per `docs/plans/collab-v1.md` §2.3 / §5.2.3 / §9 W5 Day 2:
//
//   - Always destructive: every call opens the re-approval form and,
//     on approve, decrements **both** the write and destructive
//     budgets.
//   - Refuses the pinned authoritative `.md` file
//     (`RefuseDeleteAuthoritativeError`).
//   - Refuses paths inside `.collab/` (`RefuseDeleteSentinelError`).
//   - Covers proposals, drafts, attachments happy paths.
//   - Cancel → declined audit, no counter change, file still present.

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
        // test directly so it can choose approve or cancel.
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

describe("collab_delete_file (18)", () => {
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
  // Happy path: proposals / drafts / attachments
  // -------------------------------------------------------------------------

  it("deletes drafts/proposals/attachments after approval and bumps both counters", async () => {
    const { spy, lastUrl } = pickerSpyThenCapture(
      "folder-proj",
      "/Project Foo",
      "file-spec",
      "spec.md",
    );
    const auth = new MockAuthenticator({ token: "delete-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    const projectId = /projectId: (\S+)/.exec(firstText(initResult))?.[1] ?? "";

    // Seed one file in each allowed group.
    const draft = (await c.callTool({
      name: "collab_write",
      arguments: { path: "drafts/scratch.md", content: "draft\n", source: "chat" },
    })) as ToolResult;
    expect(draft.isError).toBeFalsy();

    const proposal = (await c.callTool({
      name: "collab_write",
      arguments: { path: "proposals/P1.md", content: "proposal\n", source: "chat" },
    })) as ToolResult;
    expect(proposal.isError).toBeFalsy();

    const attachment = (await c.callTool({
      name: "collab_write",
      arguments: { path: "attachments/notes.txt", content: "note\n", source: "chat" },
    })) as ToolResult;
    expect(attachment.isError).toBeFalsy();

    const statusBefore = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const writesBefore = parseInt(/writes: (\d+)/.exec(firstText(statusBefore))?.[1] ?? "0", 10);
    const destructiveBefore = parseInt(
      /destructive approvals: (\d+)/.exec(firstText(statusBefore))?.[1] ?? "0",
      10,
    );

    // Delete the draft — approve.
    lastUrl.url = "";
    const deletePromise = c.callTool({
      name: "collab_delete_file",
      arguments: { path: "drafts/scratch.md", intent: "cleanup scratch" },
    });
    await waitForReprompt(lastUrl);
    await approveDestructive(lastUrl.url);
    const deleteResult = (await deletePromise) as ToolResult;
    expect(deleteResult.isError).toBeFalsy();
    const deleteText = firstText(deleteResult);
    expect(deleteText).toContain("deleted: scratch.md");
    expect(deleteText).toContain("path: drafts/scratch.md");

    const statusAfter = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const statusText = firstText(statusAfter);
    const writesAfter = parseInt(/writes: (\d+)/.exec(statusText)?.[1] ?? "0", 10);
    const destructiveAfter = parseInt(
      /destructive approvals: (\d+)/.exec(statusText)?.[1] ?? "0",
      10,
    );
    expect(writesAfter).toBe(writesBefore + 1);
    expect(destructiveAfter).toBe(destructiveBefore + 1);

    // Verify the file is gone from the mock store.
    const draftsFolder = [...env.graphState.driveFolderChildren.values()]
      .flat()
      .find((f) => f.name === "scratch.md");
    expect(draftsFolder).toBeUndefined();

    // Audit entries: destructive_approval (approved) + tool_call.
    const entries = await readAuditEntries(env, projectId);
    const approvedAudit = entries.find(
      (e) =>
        e["type"] === "destructive_approval" &&
        e["tool"] === "collab_delete_file" &&
        (e["details"] as Record<string, unknown>)["outcome"] === "approved",
    );
    expect(approvedAudit).toBeDefined();
    const toolCall = entries.find(
      (e) => e["type"] === "tool_call" && e["tool"] === "collab_delete_file",
    );
    expect(toolCall).toBeDefined();

    // Delete a proposal next — approve.
    lastUrl.url = "";
    const del2Promise = c.callTool({
      name: "collab_delete_file",
      arguments: { path: "proposals/P1.md" },
    });
    await waitForReprompt(lastUrl);
    await approveDestructive(lastUrl.url);
    const del2 = (await del2Promise) as ToolResult;
    expect(del2.isError).toBeFalsy();

    // And an attachment.
    lastUrl.url = "";
    const del3Promise = c.callTool({
      name: "collab_delete_file",
      arguments: { path: "attachments/notes.txt" },
    });
    await waitForReprompt(lastUrl);
    await approveDestructive(lastUrl.url);
    const del3 = (await del3Promise) as ToolResult;
    expect(del3.isError).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Cancel path: no counter change, file still present, declined audit.
  // -------------------------------------------------------------------------

  it("declines on cancel — no counter change and the file remains", async () => {
    const { spy, lastUrl } = pickerSpyThenCapture(
      "folder-proj",
      "/Project Foo",
      "file-spec",
      "spec.md",
    );
    const auth = new MockAuthenticator({ token: "delete-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    const projectId = /projectId: (\S+)/.exec(firstText(initResult))?.[1] ?? "";

    const draft = (await c.callTool({
      name: "collab_write",
      arguments: { path: "drafts/keep.md", content: "keep me\n", source: "chat" },
    })) as ToolResult;
    expect(draft.isError).toBeFalsy();

    const statusBefore = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const writesBefore = parseInt(/writes: (\d+)/.exec(firstText(statusBefore))?.[1] ?? "0", 10);
    const destructiveBefore = parseInt(
      /destructive approvals: (\d+)/.exec(firstText(statusBefore))?.[1] ?? "0",
      10,
    );

    lastUrl.url = "";
    const pending = c.callTool({
      name: "collab_delete_file",
      arguments: { path: "drafts/keep.md" },
    });
    await waitForReprompt(lastUrl);
    await cancelDestructive(lastUrl.url);
    const result = (await pending) as ToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result).toLowerCase()).toContain("declined");

    // Counters unchanged.
    const statusAfter = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const statusText = firstText(statusAfter);
    expect(parseInt(/writes: (\d+)/.exec(statusText)?.[1] ?? "0", 10)).toBe(writesBefore);
    expect(parseInt(/destructive approvals: (\d+)/.exec(statusText)?.[1] ?? "0", 10)).toBe(
      destructiveBefore,
    );

    // File still present.
    const stillThere = [...env.graphState.driveFolderChildren.values()]
      .flat()
      .find((f) => f.name === "keep.md");
    expect(stillThere).toBeDefined();

    // Audit declined entry exists; no approved or tool_call envelope.
    const entries = await readAuditEntries(env, projectId);
    const declined = entries.find(
      (e) =>
        e["type"] === "destructive_approval" &&
        e["tool"] === "collab_delete_file" &&
        (e["details"] as Record<string, unknown>)["outcome"] === "declined",
    );
    expect(declined).toBeDefined();
    const approved = entries.find(
      (e) =>
        e["type"] === "destructive_approval" &&
        e["tool"] === "collab_delete_file" &&
        (e["details"] as Record<string, unknown>)["outcome"] === "approved",
    );
    expect(approved).toBeUndefined();
    const toolCall = entries.find(
      (e) => e["type"] === "tool_call" && e["tool"] === "collab_delete_file",
    );
    expect(toolCall).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Refusal: authoritative file — never reaches the browser form.
  // -------------------------------------------------------------------------

  it("refuses to delete the authoritative .md — no browser form opens", async () => {
    const { spy } = pickerSpyThenCapture("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "delete-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    await c.callTool({ name: "session_init_project", arguments: {} });

    const result = (await c.callTool({
      name: "collab_delete_file",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Refusing to delete the authoritative file");

    // The form-factory slot must not be held — no tab was opened.
    expect(getActiveFormSlotForTest()).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Refusal: `.collab/` sentinel — pre-resolution refusal, no Graph hop.
  // -------------------------------------------------------------------------

  it("refuses any path under .collab/ as RefuseDeleteSentinelError", async () => {
    const { spy } = pickerSpyThenCapture("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "delete-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    await c.callTool({ name: "session_init_project", arguments: {} });

    const cases = [".collab/project.json", ".collab/leases.json", ".collab"];
    for (const path of cases) {
      const result = (await c.callTool({
        name: "collab_delete_file",
        arguments: { path },
      })) as ToolResult;
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("sentinel");
    }

    expect(getActiveFormSlotForTest()).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Refusal: out-of-scope path surfaces OutOfScopeError via scope resolver.
  // -------------------------------------------------------------------------

  it("refuses an out-of-scope path before opening the browser form", async () => {
    const { spy } = pickerSpyThenCapture("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "delete-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    await c.callTool({ name: "session_init_project", arguments: {} });

    const result = (await c.callTool({
      name: "collab_delete_file",
      arguments: { path: "../evil.md" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(getActiveFormSlotForTest()).toBeFalsy();
  });
});
