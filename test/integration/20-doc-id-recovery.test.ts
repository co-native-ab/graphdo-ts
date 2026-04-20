// Integration test #20: doc_id recovery (W5 Day 1).
//
// Per `docs/plans/collab-v1.md` §2.2 / §3.1 / §8.2 row 20:
//
//   Variant A — fresh machine + cooperator wiped frontmatter:
//     1. Originator does collab_write so the live + cache both carry doc_id.
//     2. Snapshot the live doc_id, wipe local cache (`docId: null`), wipe
//        live frontmatter via direct mock-Graph mutation.
//     3. session_recover_doc_id walks /versions, finds the last version
//        with parseable frontmatter, writes the recovered docId back to
//        the local cache, and emits a `doc_id_recovered` audit envelope.
//     4. Subsequent collab_write reuses the recovered doc_id.
//
//   Variant B — informational no-op (DocIdAlreadyKnownError):
//     Both live frontmatter and local cache carry a matching docId.
//     The tool returns success (NOT isError) with the existing doc_id.
//
//   Variant C — unrecoverable (DocIdUnrecoverableError):
//     No historical version of the file has parseable frontmatter
//     (none ever did). The tool returns an error directing the human
//     at session_init_project against a fresh project copy.

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
import { resetFormFactoryForTest } from "../../src/tools/collab-forms.js";
import {
  loadProjectMetadata,
  saveProjectMetadata,
  projectMetadataPath,
} from "../../src/collab/projects.js";
import { testSignal } from "../helpers.js";

let env: IntegrationEnv;

function pickerSpy(
  folderId: string,
  folderLabel: string,
  fileId: string,
  fileLabel: string,
): { spy: (url: string) => Promise<void> } {
  let call = 0;
  const spy = (url: string): Promise<void> => {
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
    }, 50);
    return Promise.resolve();
  };
  return { spy };
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

describe("20-doc-id-recovery", () => {
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
  // Variant A — fresh machine + cooperator wiped frontmatter
  // -------------------------------------------------------------------------

  it("recovers doc_id from /versions when both frontmatter and local cache are wiped", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(initResult.isError).toBeFalsy();
    const projectId = /projectId: (\S+)/.exec(firstText(initResult))?.[1] ?? "";
    expect(projectId).not.toBe("");

    // First write seeds live + cache with a real doc_id (snapshots the
    // pre-existing seed content into /versions as the oldest entry).
    const r1 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag1 = /cTag: (\S+)/.exec(firstText(r1))?.[1];
    const w1 = (await c.callTool({
      name: "collab_write",
      arguments: {
        path: "spec.md",
        content: "# Original\n\nbody1\n",
        cTag: cTag1,
        source: "chat",
      },
    })) as ToolResult;
    expect(w1.isError).toBeFalsy();

    const specFile = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    if (!specFile) throw new Error("spec file missing");
    const originalDocId = /doc_id: "([^"]+)"/.exec(specFile.content ?? "")?.[1];
    expect(originalDocId).toBeDefined();
    expect(originalDocId).not.toBe("");

    // Second write so the first-write content (with frontmatter) is
    // snapshotted into /versions as a historical entry. Without this
    // step the only on-disk frontmatter copy is the *current* version,
    // which Graph rejects content downloads for via the /versions
    // sub-resource.
    const r2 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag2 = /cTag: (\S+)/.exec(firstText(r2))?.[1];
    const w2 = (await c.callTool({
      name: "collab_write",
      arguments: {
        path: "spec.md",
        content: "# Original\n\nbody2\n",
        cTag: cTag2,
        source: "chat",
      },
    })) as ToolResult;
    expect(w2.isError).toBeFalsy();

    // Wipe live frontmatter and the local cache to simulate a fresh
    // machine + a cooperator stripping the YAML envelope in OneDrive
    // web. The historical /versions entry created by the second write
    // still carries the original frontmatter with the doc_id.
    specFile.content = "# Without frontmatter\n\njust a body\n";
    specFile.size = Buffer.byteLength(specFile.content, "utf-8");
    const metadataBefore = await loadProjectMetadata(env.configDir, projectId, testSignal());
    if (!metadataBefore) throw new Error("metadata missing");
    await saveProjectMetadata(env.configDir, { ...metadataBefore, docId: null }, testSignal());

    const recover = (await c.callTool({
      name: "session_recover_doc_id",
      arguments: {},
    })) as ToolResult;
    expect(recover.isError).toBeFalsy();
    const recoverText = firstText(recover);
    expect(recoverText).toContain("doc_id recovered.");
    expect(recoverText).toContain(`doc_id: ${originalDocId}`);

    // Local cache now carries the recovered docId.
    const metadataAfter = await loadProjectMetadata(env.configDir, projectId, testSignal());
    expect(metadataAfter?.docId).toBe(originalDocId);

    // Audit entry recorded.
    const entries = await readAuditEntries(env, projectId);
    const recovered = entries.find((e) => e["type"] === "doc_id_recovered");
    expect(recovered).toBeDefined();
    expect(recovered?.["tool"]).toBe("session_recover_doc_id");
    const details = recovered?.["details"] as Record<string, unknown>;
    expect(typeof details["recoveredFrom"]).toBe("string");
    expect(typeof details["versionsInspected"]).toBe("number");
    expect(details["versionsInspected"] as number).toBeGreaterThan(0);

    // The next collab_write reuses the recovered doc_id.
    const r3 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag3 = /cTag: (\S+)/.exec(firstText(r3))?.[1];
    const w3 = (await c.callTool({
      name: "collab_write",
      arguments: { path: "spec.md", content: "# Reused\n", cTag: cTag3, source: "chat" },
    })) as ToolResult;
    expect(w3.isError).toBeFalsy();
    const reusedDocId = /doc_id: "([^"]+)"/.exec(specFile.content ?? "")?.[1];
    expect(reusedDocId).toBe(originalDocId);
  });

  // -------------------------------------------------------------------------
  // Variant B — informational no-op (DocIdAlreadyKnownError)
  // -------------------------------------------------------------------------

  it("returns informational message (not isError) when both live + cache already match", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    await c.callTool({ name: "session_init_project", arguments: {} });
    const r1 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag1 = /cTag: (\S+)/.exec(firstText(r1))?.[1];
    await c.callTool({
      name: "collab_write",
      arguments: { path: "spec.md", content: "# v1\n", cTag: cTag1, source: "chat" },
    });

    const specFile = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    if (!specFile) throw new Error("spec file missing");
    const docId = /doc_id: "([^"]+)"/.exec(specFile.content ?? "")?.[1];
    expect(docId).toBeDefined();

    const recover = (await c.callTool({
      name: "session_recover_doc_id",
      arguments: {},
    })) as ToolResult;
    expect(recover.isError).toBeFalsy();
    const text = firstText(recover);
    expect(text).toContain("Nothing to recover.");
    expect(text).toContain(`doc_id: ${docId}`);
  });

  // -------------------------------------------------------------------------
  // Variant C — unrecoverable (DocIdUnrecoverableError)
  // -------------------------------------------------------------------------

  it("errors with DocIdUnrecoverableError when no version yields a parseable doc_id", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(initResult.isError).toBeFalsy();
    const projectId = /projectId: (\S+)/.exec(firstText(initResult))?.[1] ?? "";

    // No collab_write was ever issued, so the file has no historical
    // version with frontmatter. Wipe the local cache and confirm the
    // walk exhausts.
    const metadataBefore = await loadProjectMetadata(env.configDir, projectId, testSignal());
    if (!metadataBefore) throw new Error("metadata missing");
    await saveProjectMetadata(env.configDir, { ...metadataBefore, docId: null }, testSignal());

    const recover = (await c.callTool({
      name: "session_recover_doc_id",
      arguments: {},
    })) as ToolResult;
    expect(recover.isError).toBe(true);
    const text = firstText(recover);
    expect(text).toContain("doc_id cannot be recovered automatically");
    expect(text).toContain("session_init_project");
    // Local cache still has docId === null after a failed walk.
    const metadataAfter = await loadProjectMetadata(env.configDir, projectId, testSignal());
    expect(metadataAfter?.docId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Bonus — projectMetadataPath helper used elsewhere in tests stays exported
  // -------------------------------------------------------------------------

  it("projectMetadataPath helper is still importable", () => {
    expect(typeof projectMetadataPath("/tmp/x", "01J")).toBe("string");
  });
});
