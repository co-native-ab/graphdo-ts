// Integration test for `session_status` (W1 Day 5).
//
// DoD per `docs/plans/collab-v1.md` §9 (W1 Day 5):
//
//   > status tool reports an active session and survives a simulated
//   > process restart.
//
// The "process restart" half is interpreted per §2.2 ("OS process exit
// ends the session") together with §3.7 ("Persisted to disk so a
// crash-and-restart agent does not get a fresh budget within the same
// session window"): after a simulated restart the in-memory session is
// gone (status returns NoActiveSessionError) but the destructive-counter
// sidecar is still on disk so a future `session_open_project` can rebind
// without resetting the budget.

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
  destructiveCountsPath,
  DestructiveCountsFileSchema,
} from "../../src/collab/session-counts.js";

let env: IntegrationEnv;

function pickerSpy(
  folderId: string,
  folderLabel: string,
  fileId: string,
  fileLabel: string,
): {
  spy: (url: string) => Promise<void>;
  captured: { url: string };
} {
  const captured = { url: "" };
  let call = 0;
  const spy = (url: string): Promise<void> => {
    captured.url = url;
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

describe("integration: session_status (W1 Day 5)", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedSingleMarkdownFolder(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  it("returns NoActiveSessionError before any session is started", async () => {
    const auth = new MockAuthenticator({
      token: "no-session-token",
      username: "alice@example.com",
      userOid: "00000000-0000-0000-0000-0000a3f2c891",
    });
    const c = await createTestClient(env, auth);

    const result = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("No active collab session");
  });

  it("reports the active session after session_init_project", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({
      token: "init-token",
      username: "alice@example.com",
      userOid: "00000000-0000-0000-0000-0000a3f2c891",
    });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const init = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();
    const initText = firstText(init);
    expect(initText).toContain("Session active.");
    expect(initText).toMatch(/sessionId: [0-9A-HJKMNP-TV-Z]{26}/);
    expect(initText).toMatch(/agentId: [0-9a-f]{8}-unknown-[0-9a-z]{1,8}/);

    const status = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(status.isError).toBeFalsy();
    const text = firstText(status);
    expect(text).toContain("Collab session: active");
    expect(text).toContain("folderPath: /Project Foo");
    expect(text).toContain("authoritativeFile: spec.md");
    // userOid is reported as the trailing 8 chars (suffix) per §2.2.
    expect(text).toContain("userOid: ...a3f2c891");
    expect(text).toContain("writes: 0 / 50");
    expect(text).toContain("destructive approvals: 0 / 10");
    expect(text).toContain("renewals (this session): 0 / 3");
    expect(text).toContain("source counters: chat=0 project=0 external=0");
    expect(text).toContain("expired: false");
    // 2h default TTL — secondsRemaining should be close to 7200 but
    // tolerate a few seconds of clock drift.
    const m = /secondsRemaining: (\d+)/.exec(text);
    expect(m).not.toBeNull();
    const remaining = Number(m?.[1]);
    expect(remaining).toBeGreaterThan(7100);
    expect(remaining).toBeLessThanOrEqual(7200);
  });

  it("refuses session_init_project when a session is already active", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({
      token: "init-token",
      username: "alice@example.com",
      userOid: "00000000-0000-0000-0000-0000a3f2c891",
    });
    const c = await createTestClient(env, auth, { openBrowser: spy });

    const first = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(first.isError).toBeFalsy();

    const second = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(second.isError).toBe(true);
    expect(firstText(second)).toContain("active collab session is already running");
  });

  it("destructive-counts sidecar persists across a simulated process restart", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({
      token: "init-token",
      username: "alice@example.com",
      userOid: "00000000-0000-0000-0000-0000a3f2c891",
    });

    // Run 1: start a session in server A.
    const cA = await createTestClient(env, auth, { openBrowser: spy });
    const init = (await cA.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();
    const sessionIdMatch = /sessionId: ([0-9A-HJKMNP-TV-Z]{26})/.exec(firstText(init));
    expect(sessionIdMatch).not.toBeNull();
    const sessionId = sessionIdMatch?.[1] ?? "";

    // Sidecar exists on disk with the session entry.
    const raw = await readFile(destructiveCountsPath(env.configDir), "utf-8");
    const parsed = DestructiveCountsFileSchema.parse(JSON.parse(raw));
    expect(parsed.sessions[sessionId]).toMatchObject({
      destructiveBudgetTotal: 10,
      destructiveUsed: 0,
      writeBudgetTotal: 50,
      writesUsed: 0,
      renewalsUsed: 0,
    });

    // Run 2: simulate process restart by spinning up a brand-new server
    // against the same configDir. Per §2.2 the in-memory session is gone.
    const cB = await createTestClient(env, auth);
    const status = (await cB.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(status.isError).toBe(true);
    expect(firstText(status)).toContain("No active collab session");

    // ...but the sidecar is still on disk for the new process to rebind
    // when `session_open_project` lands in W4 Day 4.
    const rawAfter = await readFile(destructiveCountsPath(env.configDir), "utf-8");
    const parsedAfter = DestructiveCountsFileSchema.parse(JSON.parse(rawAfter));
    expect(parsedAfter.sessions[sessionId]).toMatchObject({
      destructiveBudgetTotal: 10,
      writeBudgetTotal: 50,
    });
  });
});
