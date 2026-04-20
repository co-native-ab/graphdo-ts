// Integration test #19: session survives MCP transport reconnect.
//
// W5 Day 3 — `docs/plans/collab-v1.md` §2.2 + §8.2 row 19:
//
//   - Active session in process P. Drop the (in-memory) MCP transport
//     without exiting P. Open a new transport against P. Active session
//     is the same `sessionId`; budgets and destructive counter unchanged.
//   - Variant: kill P; restart; session is gone. Modelled here as a
//     fresh `SessionRegistry` (no surviving in-memory state) — the
//     spec's point is that the registry is bound to the OS process, not
//     the transport. A new process means a new registry, which means no
//     active session.
//
// The fixture exercises the architectural property: `SessionRegistry`
// is server-scoped (created once in `createMcpServer()`) but, when
// `opts.sessionRegistry` is provided, threaded through to a fresh
// `McpServer` so a second `Client.connect()` lands on the same in-memory
// session.

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
import { SessionRegistry } from "../../src/collab/session.js";
import { newUlid } from "../../src/collab/ulid.js";

let env: IntegrationEnv;

function pickerSpy(folderId: string, folderLabel: string, fileId: string, fileLabel: string) {
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

function buildRegistry(configDir: string): SessionRegistry {
  return new SessionRegistry(
    configDir,
    () => newUlid(() => Date.now()),
    () => new Date(),
  );
}

describe("19-session-survives-reconnect", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedSingleMarkdownFolder(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  it("session sessionId/budgets/destructive counter survive a transport reconnect inside the same process", async () => {
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });

    // Process-scoped registry that survives the disconnect/reconnect.
    const registry = buildRegistry(env.configDir);

    // ---- First transport: init the session ----
    const { spy: spy1 } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const c1 = await createTestClient(env, auth, {
      openBrowser: spy1,
      sessionRegistry: registry,
    });

    const initResult = (await c1.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(initResult.isError).toBeFalsy();

    const status1 = (await c1.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const text1 = firstText(status1);
    const sessionIdBefore = registry.snapshot()?.sessionId;
    expect(sessionIdBefore).toBeDefined();
    expect(text1).toContain("Collab session: active");
    const writesBefore = registry.snapshot()?.writesUsed ?? -1;
    const destructiveBefore = registry.snapshot()?.destructiveUsed ?? -1;
    const writeBudgetBefore = registry.snapshot()?.writeBudgetTotal ?? -1;
    const destructiveBudgetBefore = registry.snapshot()?.destructiveBudgetTotal ?? -1;

    // ---- Drop the transport ----
    await c1.close();

    // The in-memory session must still be present after the client/transport
    // pair is closed (the registry is process-scoped, not transport-scoped).
    const snapAfterDisconnect = registry.snapshot();
    expect(snapAfterDisconnect).not.toBeNull();
    expect(snapAfterDisconnect?.sessionId).toBe(sessionIdBefore);

    // ---- Open a fresh transport (same registry) ----
    const c2 = await createTestClient(env, auth, {
      sessionRegistry: registry,
      // The session already exists; no picker invoked. Provide a no-op
      // browser so the test fails loudly if a tool unexpectedly opens
      // one.
      openBrowser: () => Promise.reject(new Error("unexpected browser open during reconnect")),
    });

    const status2 = (await c2.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(status2.isError).toBeFalsy();
    const text2 = firstText(status2);
    expect(text2).toContain("Collab session: active");
    expect(text2).toContain(`agentId:`);

    // Same sessionId, same budgets, same destructive counter.
    const snapAfterReconnect = registry.snapshot();
    expect(snapAfterReconnect?.sessionId).toBe(sessionIdBefore);
    expect(snapAfterReconnect?.writesUsed).toBe(writesBefore);
    expect(snapAfterReconnect?.destructiveUsed).toBe(destructiveBefore);
    expect(snapAfterReconnect?.writeBudgetTotal).toBe(writeBudgetBefore);
    expect(snapAfterReconnect?.destructiveBudgetTotal).toBe(destructiveBudgetBefore);

    await c2.close();
  });

  it("variant: a fresh process (new SessionRegistry) reports no active session", async () => {
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });

    const firstRegistry = buildRegistry(env.configDir);
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const c1 = await createTestClient(env, auth, {
      openBrowser: spy,
      sessionRegistry: firstRegistry,
    });

    const initResult = (await c1.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(initResult.isError).toBeFalsy();
    expect(firstRegistry.snapshot()).not.toBeNull();
    await c1.close();

    // Simulate process exit + restart: a fresh SessionRegistry has no
    // in-memory session even though the on-disk artefacts (sentinel,
    // pin block, recents, destructive-counts sidecar) still exist.
    const secondRegistry = buildRegistry(env.configDir);
    expect(secondRegistry.snapshot()).toBeNull();

    const c2 = await createTestClient(env, auth, {
      sessionRegistry: secondRegistry,
      openBrowser: () => Promise.reject(new Error("unexpected browser open in fresh process")),
    });

    const status = (await c2.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(status.isError).toBe(true);
    expect(firstText(status)).toContain("No active collab session");

    await c2.close();
  });
});
