// Integration test #21: warn-once `agent_name_unknown` audit envelope.
//
// W5 Day 3 — agentId fallback (`docs/plans/collab-v1.md` §2.2 + §10
// question 4 + §3.6 row 11 + §8.2 row 21):
//
//   - Connecting client supplies a `clientInfo` payload with an empty /
//     missing `name`. The session registry slugifies the name into the
//     middle segment of `agentId`; an empty / non-slug value falls back
//     to `"unknown"`.
//   - The first tool call in the new session emits exactly one
//     `agent_name_unknown` audit envelope carrying
//     `clientInfoPresent: boolean` + `agentIdAssigned`. Subsequent tool
//     calls in the same session do **not** repeat the warn.
//
// The DoD is: agentId middle segment === "unknown", exactly one
// `agent_name_unknown` row in the project audit jsonl after the second
// tool call.

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

let env: IntegrationEnv;

function pickerSpy(folderId: string, folderLabel: string, fileId: string, fileLabel: string) {
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

interface AuditRow {
  type: string;
  agentId?: string;
  details?: Record<string, unknown>;
}

async function readAuditRows(env: IntegrationEnv, projectId: string): Promise<AuditRow[]> {
  const path = `${env.configDir}/sessions/audit/${projectId}.jsonl`;
  const raw = await readFile(path, { encoding: "utf-8" });
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRow);
}

describe("21-agent-name-unknown", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedSingleMarkdownFolder(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  it("emits a single agent_name_unknown audit when clientInfo.name is empty, agentId middle segment is 'unknown', and does not re-emit on subsequent tool calls", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });

    // Connect with clientInfo whose `name` is the empty string. The
    // registry slugifier returns `"unknown"` (empty / all-non-slug).
    const c = await createTestClient(env, auth, {
      openBrowser: spy,
      clientInfo: { name: "", version: "1.2.3" },
    });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(initResult.isError).toBeFalsy();
    const initText = firstText(initResult);
    const projectId = /projectId: (\S+)/.exec(initText)?.[1] ?? "";
    expect(projectId.length).toBeGreaterThan(0);

    // The agentId rendered in the success text must carry the literal
    // `"unknown"` middle segment.
    const agentIdMatch = /agentId: (\S+)/.exec(initText);
    const agentId = agentIdMatch?.[1] ?? "";
    expect(agentId).toMatch(/^[0-9a-f]{8}-unknown-[0-9a-z]{8}$/);

    let rows = await readAuditRows(env, projectId);
    let unknown = rows.filter((r) => r.type === "agent_name_unknown");
    expect(unknown.length).toBe(1);
    expect(unknown[0]?.agentId).toBe(agentId);
    expect(unknown[0]?.details).toMatchObject({
      clientInfoPresent: true,
      agentIdAssigned: agentId,
    });

    // Subsequent tool calls in the SAME session must not append another
    // `agent_name_unknown` row (warn-once-per-session).
    const statusResult = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(statusResult.isError).toBeFalsy();

    const writeResult = (await c.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    expect(writeResult.isError).toBeFalsy();

    rows = await readAuditRows(env, projectId);
    unknown = rows.filter((r) => r.type === "agent_name_unknown");
    expect(unknown.length).toBe(1);
  });

  it("known clientInfo.name does not emit agent_name_unknown and slugifies into agentId", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "init-token", username: "alice@example.com" });

    const c = await createTestClient(env, auth, {
      openBrowser: spy,
      clientInfo: { name: "Claude Desktop", version: "0.7.0" },
    });

    const initResult = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(initResult.isError).toBeFalsy();
    const initText = firstText(initResult);
    const projectId = /projectId: (\S+)/.exec(initText)?.[1] ?? "";
    const agentId = /agentId: (\S+)/.exec(initText)?.[1] ?? "";
    // "Claude Desktop" → "claude-desktop"
    expect(agentId).toMatch(/^[0-9a-f]{8}-claude-desktop-[0-9a-z]{8}$/);

    const rows = await readAuditRows(env, projectId);
    const unknown = rows.filter((r) => r.type === "agent_name_unknown");
    expect(unknown.length).toBe(0);

    // The session_start envelope carries the raw clientName / clientVersion.
    const sessionStart = rows.find((r) => r.type === "session_start");
    expect(sessionStart?.details).toMatchObject({
      clientName: "Claude Desktop",
      clientVersion: "0.7.0",
    });
  });
});
