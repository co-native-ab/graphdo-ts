// Integration test #04: frontmatter stripped (collab v1 §10).
//
// **Status: W3 Day 3 — lit up alongside the audit writer.**
//
// The W2 Day 2 codec helpers (`readMarkdownFrontmatter`,
// `resolveDocId`, `DocIdRecoveryRequiredError`), W2 Day 4
// `collab_read`, W3 Day 2 `collab_write`, and the W3 Day 3 audit
// writer combine into the end-to-end scenario described by
// `docs/plans/collab-v1.md` §8.2 row 04:
//
//   1. Direct mock-Graph write that wipes frontmatter (simulates the
//      OneDrive web "remove formatting" affordance).
//   2. Next `collab_read` returns defaults for the `collab` block and
//      echoes the body. A `frontmatter_reset` audit entry is appended
//      with `reason: "missing"`, `recoveredDocId: true` (cache is still
//      populated from the original write), and the file's pre-read
//      `cTag` as `previousRevision`.
//   3. Next `collab_write` re-injects the **same `doc_id`** recovered
//      from `<configDir>/projects/<projectId>.json`.
//   4. Variant — local project metadata also wiped between the read
//      and the write: `collab_write` against the authoritative file
//      surfaces an error (the loader cannot find the metadata cache),
//      pointing the agent at the recovery path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, unlink } from "node:fs/promises";

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
import { projectMetadataPath } from "../../src/collab/projects.js";

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
    }, 150);
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

describe("04-frontmatter-stripped", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedSingleMarkdownFolder(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  it("collab_read on a frontmatter-stripped authoritative file returns defaults and writes a `frontmatter_reset` audit entry", async () => {
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

    // First write seeds the cache + live frontmatter with a doc_id.
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

    // Simulate the OneDrive UI stripping the frontmatter envelope.
    const specFile = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    if (!specFile) throw new Error("spec file missing");
    specFile.content = "# Without frontmatter\n\njust a body\n";
    specFile.size = Buffer.byteLength(specFile.content, "utf-8");

    const r2 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    expect(r2.isError).toBeFalsy();
    const r2Text = firstText(r2);
    expect(r2Text).toContain("isAuthoritative: true");
    expect(r2Text).toContain("null (not parsed / reset)");
    expect(r2Text).toContain("just a body");

    // Audit log carries one frontmatter_reset per stripped read. The
    // first read (before any write) sees a stripped envelope because
    // the seed file has no frontmatter; the second read picks up the
    // explicit strip. Both emissions are correct per §3.6 — assert
    // the exact count so duplicate-emission regressions are caught.
    const entries = await readAuditEntries(env, projectId);
    const resets = entries.filter(
      (e) => e["type"] === "frontmatter_reset" && e["tool"] === "collab_read",
    );
    expect(resets.length).toBe(2);
    const details = resets.at(-1)!["details"] as Record<string, unknown>;
    expect(details["reason"]).toBe("missing");
    expect(details["recoveredDocId"]).toBe(true);
  });

  it("the next collab_write re-injects the same doc_id recovered from local project metadata", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(initResult.isError).toBeFalsy();

    const r1 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag1 = /cTag: (\S+)/.exec(firstText(r1))?.[1];
    const w1 = (await c.callTool({
      name: "collab_write",
      arguments: { path: "spec.md", content: "# v1\n", cTag: cTag1, source: "chat" },
    })) as ToolResult;
    expect(w1.isError).toBeFalsy();

    const specFile = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    if (!specFile) throw new Error("spec file missing");
    const originalDocId = /doc_id: "([^"]+)"/.exec(specFile.content ?? "")?.[1];
    expect(originalDocId).toBeDefined();

    // Strip the live frontmatter.
    specFile.content = "# Stripped\n\nbody only\n";
    specFile.size = Buffer.byteLength(specFile.content, "utf-8");

    const r2 = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag2 = /cTag: (\S+)/.exec(firstText(r2))?.[1];

    const w2 = (await c.callTool({
      name: "collab_write",
      arguments: { path: "spec.md", content: "# Recovered\n", cTag: cTag2, source: "chat" },
    })) as ToolResult;
    expect(w2.isError).toBeFalsy();

    const recoveredDocId = /doc_id: "([^"]+)"/.exec(specFile.content ?? "")?.[1];
    expect(recoveredDocId).toBe(originalDocId);
  });

  it("Variant — local project metadata wiped: collab_write surfaces a metadata-not-found error", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(initResult.isError).toBeFalsy();
    const projectId = /projectId: (\S+)/.exec(firstText(initResult))?.[1] ?? "";

    // Strip the live frontmatter.
    const specFile = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    if (!specFile) throw new Error("spec file missing");
    specFile.content = "# Stripped\n\nbody only\n";
    specFile.size = Buffer.byteLength(specFile.content, "utf-8");

    // Wipe the local project metadata cache.
    await unlink(projectMetadataPath(env.configDir, projectId));

    const w = (await c.callTool({
      name: "collab_write",
      arguments: {
        path: "spec.md",
        content: "# fresh\n",
        cTag: '"c:{file-spec},1"',
        source: "chat",
      },
    })) as ToolResult;
    expect(w.isError).toBe(true);
    expect(firstText(w)).toContain("Project metadata not found");
  });
});
