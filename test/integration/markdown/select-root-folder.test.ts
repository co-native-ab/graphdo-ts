// Integration tests: markdown_select_root_folder browser picker

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  firstText,
  MockAuthenticator,
  createMcpServer,
  InMemoryTransport,
  Client,
  fetchCsrfToken,
  testSignal,
  saveConfig,
  loadConfig,
  type IntegrationEnv,
  type ToolResult,
} from "../helpers.js";
import { seedDrive } from "./_helpers.js";

let env: IntegrationEnv;

describe("integration: markdown_select_root_folder", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  beforeEach(() => {
    seedDrive(env);
  });

  it("markdown_select_root_folder configures root via browser picker (full e2e)", async () => {
    const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-e2e-"));

    try {
      let capturedUrl = "";
      const browserSpy = (url: string): Promise<void> => {
        capturedUrl = url;
        setTimeout(() => {
          void (async () => {
            const csrfToken = await fetchCsrfToken(url);
            await fetch(`${url}/select`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "folder-2", label: "/Work", csrfToken }),
            });
          })();
        }, 150);
        return Promise.resolve();
      };

      const auth = new MockAuthenticator({ token: "md-select-token" });
      const server = await createMcpServer(
        {
          authenticator: auth,
          graphBaseUrl: env.graphUrl,
          configDir: tempConfigDir,
          openBrowser: browserSpy,
        },
        testSignal(),
      );
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "test", version: "1.0" });
      await server.connect(st);
      await c.connect(ct);

      const result = (await c.callTool({
        name: "markdown_select_root_folder",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("browser window has been opened");
      expect(text).toContain("folder-2");
      expect(capturedUrl).toContain("http://127.0.0.1:");

      const cfg = await loadConfig(tempConfigDir, testSignal());
      expect(cfg?.markdown?.rootFolderId).toBe("folder-2");
      expect(cfg?.markdown?.rootFolderName).toBe("Work");
    } finally {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("markdown_select_root_folder embeds the drive's webUrl from /me/drive into the picker page", async () => {
    // Set a recognisable webUrl on the mock and assert the picker HTML
    // references that URL (not the hardcoded onedrive.live.com fallback).
    env.graphState.drive = {
      id: "drive-xyz",
      driveType: "business",
      webUrl: "https://contoso-my.sharepoint.com/personal/test_contoso_com/Documents",
    };
    const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-weburl-"));

    try {
      let capturedUrl = "";
      let capturedHtml = "";
      const browserSpy = async (url: string): Promise<void> => {
        capturedUrl = url;
        // Fetch the picker page while the server is still running.
        const res = await fetch(url);
        capturedHtml = await res.text();
        const csrfToken = await fetchCsrfToken(url);
        setTimeout(() => {
          void fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "folder-1", label: "/Notes", csrfToken }),
          });
        }, 50);
      };

      const auth = new MockAuthenticator({ token: "md-weburl-token" });
      const server = await createMcpServer(
        {
          authenticator: auth,
          graphBaseUrl: env.graphUrl,
          configDir: tempConfigDir,
          openBrowser: browserSpy,
        },
        testSignal(),
      );
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "test", version: "1.0" });
      await server.connect(st);
      await c.connect(ct);

      const result = (await c.callTool({
        name: "markdown_select_root_folder",
        arguments: {},
      })) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(capturedUrl).toContain("http://127.0.0.1:");
      expect(capturedHtml).toContain(
        "https://contoso-my.sharepoint.com/personal/test_contoso_com/Documents",
      );
      expect(capturedHtml).not.toContain("https://onedrive.live.com/");
    } finally {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("markdown_select_root_folder falls back to onedrive.live.com when /me/drive has no webUrl", async () => {
    env.graphState.drive = { id: "drive-abc", driveType: "personal", webUrl: "" };
    const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-fallback-"));
    try {
      let capturedHtml = "";
      const browserSpy = async (url: string): Promise<void> => {
        const res = await fetch(url);
        capturedHtml = await res.text();
        const csrfToken = await fetchCsrfToken(url);
        setTimeout(() => {
          void fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "folder-1", label: "/Notes", csrfToken }),
          });
        }, 50);
      };
      const auth = new MockAuthenticator({ token: "md-fallback-token" });
      const server = await createMcpServer(
        {
          authenticator: auth,
          graphBaseUrl: env.graphUrl,
          configDir: tempConfigDir,
          openBrowser: browserSpy,
        },
        testSignal(),
      );
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "test", version: "1.0" });
      await server.connect(st);
      await c.connect(ct);

      const result = (await c.callTool({
        name: "markdown_select_root_folder",
        arguments: {},
      })) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(capturedHtml).toContain("https://onedrive.live.com/");
    } finally {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("markdown_select_root_folder preserves existing todo_select_list fields", async () => {
    const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-merge-"));
    try {
      await saveConfig(
        { todoListId: "keep-me", todoListName: "Keep Me" },
        tempConfigDir,
        testSignal(),
      );

      const browserSpy = (url: string): Promise<void> => {
        setTimeout(() => {
          void (async () => {
            const csrfToken = await fetchCsrfToken(url);
            await fetch(`${url}/select`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "folder-1", label: "/Notes", csrfToken }),
            });
          })();
        }, 150);
        return Promise.resolve();
      };

      const auth = new MockAuthenticator({ token: "md-merge-token" });
      const server = await createMcpServer(
        {
          authenticator: auth,
          graphBaseUrl: env.graphUrl,
          configDir: tempConfigDir,
          openBrowser: browserSpy,
        },
        testSignal(),
      );
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "test", version: "1.0" });
      await server.connect(st);
      await c.connect(ct);

      const r = (await c.callTool({
        name: "markdown_select_root_folder",
        arguments: {},
      })) as ToolResult;
      expect(r.isError).toBeFalsy();

      const cfg = await loadConfig(tempConfigDir, testSignal());
      expect(cfg?.todoListId).toBe("keep-me");
      expect(cfg?.markdown?.rootFolderId).toBe("folder-1");
    } finally {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("markdown_select_root_folder reports no folders when OneDrive root is empty", async () => {
    const originalRoot = env.graphState.driveRootChildren;
    env.graphState.driveRootChildren = [];

    try {
      const auth = new MockAuthenticator({ token: "md-empty-token" });
      const c = await createTestClient(env, auth);
      const r = (await c.callTool({
        name: "markdown_select_root_folder",
        arguments: {},
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(firstText(r)).toContain("No top-level folders");
    } finally {
      env.graphState.driveRootChildren = originalRoot;
    }
  });
});
