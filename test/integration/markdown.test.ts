// Integration tests for OneDrive-backed markdown tools.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

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
} from "./helpers.js";

function seedDrive(env: IntegrationEnv): void {
  // Reset drive metadata too — some earlier tests overwrite drive.webUrl
  // (e.g. to test the empty-webUrl fallback) and leave it that way.
  env.graphState.drive = {
    id: "mock-drive-1",
    driveType: "business",
    webUrl: "https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents",
  };
  env.graphState.driveRootChildren = [
    { id: "folder-1", name: "Notes", folder: {}, lastModifiedDateTime: "2026-04-10T10:00:00Z" },
    { id: "folder-2", name: "Work", folder: {}, lastModifiedDateTime: "2026-04-11T10:00:00Z" },
  ];
  env.graphState.driveFolderChildren.set("folder-1", [
    {
      id: "file-md-1",
      name: "hello.md",
      size: 5,
      lastModifiedDateTime: "2026-04-10T11:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "hello",
    },
    {
      id: "file-txt",
      name: "readme.txt",
      size: 5,
      lastModifiedDateTime: "2026-04-10T11:00:00Z",
      file: { mimeType: "text/plain" },
      content: "plain",
    },
  ]);
  env.graphState.driveFolderChildren.set("folder-2", []);
  // Historical versions are stored in a separate map that is NOT cleared by
  // replacing driveFolderChildren. Reset it here so version-related tests
  // start from a known-clean state and don't see leftovers from prior runs.
  env.graphState.driveItemVersions.clear();
}

let env: IntegrationEnv;

describe("integration: markdown", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  beforeEach(() => {
    seedDrive(env);
  });

  // -------------------------------------------------------------------------
  // Scope gating
  // -------------------------------------------------------------------------

  it("markdown tools are hidden when Files.ReadWrite not granted", async () => {
    const noAuth = new MockAuthenticator();
    const c = await createTestClient(env, noAuth);
    const { tools } = await c.listTools();
    const names = tools.map((t: { name: string }) => t.name);
    for (const n of [
      "markdown_select_root_folder",
      "markdown_list_files",
      "markdown_get_file",
      "markdown_create_file",
      "markdown_update_file",
      "markdown_delete_file",
      "markdown_preview_file",
    ]) {
      expect(names).not.toContain(n);
    }
  });

  // -------------------------------------------------------------------------
  // "Not configured" errors
  // -------------------------------------------------------------------------

  it("markdown_list_files returns an error when root folder not configured", async () => {
    const auth = new MockAuthenticator({ token: "md-token" });
    const c = await createTestClient(env, auth);
    const result = (await c.callTool({
      name: "markdown_list_files",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("markdown root folder not configured");
  });

  it("markdown_get_file, markdown_create_file, markdown_update_file, markdown_delete_file all require configuration", async () => {
    const auth = new MockAuthenticator({ token: "md-token" });
    const c = await createTestClient(env, auth);

    for (const call of [
      { name: "markdown_get_file", arguments: { fileName: "x.md" } },
      { name: "markdown_create_file", arguments: { fileName: "x.md", content: "x" } },
      {
        name: "markdown_update_file",
        arguments: { fileName: "x.md", cTag: "any", content: "x" },
      },
      { name: "markdown_delete_file", arguments: { fileName: "x.md" } },
      {
        name: "markdown_diff_file_versions",
        arguments: { fileName: "x.md", fromVersionId: "a", toVersionId: "b" },
      },
    ]) {
      const r = (await c.callTool(call)) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain("markdown root folder not configured");
    }
  });

  it("rejects a manually-corrupted config whose rootFolderId is '/' with a clear error that points back to the picker", async () => {
    // Simulate someone editing config.json by hand and putting "/" (the drive
    // root) where a single folder ID is expected. All four markdown tools
    // must refuse to run and direct the user to markdown_select_root_folder.
    const dir = await mkdtemp(path.join(tmpdir(), "graphdo-md-bad-"));
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({ markdown: { rootFolderId: "/" } }),
      );

      const auth = new MockAuthenticator({ token: "md-bad-token" });
      const server = await createMcpServer(
        {
          authenticator: auth,
          graphBaseUrl: env.graphUrl,
          configDir: dir,
          openBrowser: () => Promise.reject(new Error("no browser in tests")),
        },
        testSignal(),
      );
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "1.0" });
      await server.connect(st);
      await client.connect(ct);

      for (const call of [
        { name: "markdown_list_files", arguments: {} },
        { name: "markdown_get_file", arguments: { fileName: "x.md" } },
        { name: "markdown_create_file", arguments: { fileName: "x.md", content: "x" } },
        {
          name: "markdown_update_file",
          arguments: { fileName: "x.md", cTag: "any", content: "x" },
        },
        { name: "markdown_delete_file", arguments: { fileName: "x.md" } },
      ]) {
        const r = (await client.callTool(call)) as ToolResult;
        expect(r.isError, `${call.name} should fail`).toBe(true);
        const text = firstText(r);
        expect(text).toMatch(/markdown root folder/i);
        expect(text).toMatch(/drive root|invalid/i);
        expect(text).toContain("markdown_select_root_folder");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a manually-corrupted config whose rootFolderId contains a subpath", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graphdo-md-bad2-"));
    try {
      await saveConfig(
        // saveConfig's schema allows any non-empty string, matching a hand-edit
        { markdown: { rootFolderId: "folder-1/sub" } } as Parameters<typeof saveConfig>[0],
        dir,
        testSignal(),
      );

      const auth = new MockAuthenticator({ token: "md-bad-token" });
      const server = await createMcpServer(
        {
          authenticator: auth,
          graphBaseUrl: env.graphUrl,
          configDir: dir,
          openBrowser: () => Promise.reject(new Error("no browser in tests")),
        },
        testSignal(),
      );
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "1.0" });
      await server.connect(st);
      await client.connect(ct);

      const r = (await client.callTool({
        name: "markdown_list_files",
        arguments: {},
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toMatch(/path separator/);
      expect(firstText(r)).toContain("markdown_select_root_folder");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Browser-picker root folder selection
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // File operations with configured root
  // -------------------------------------------------------------------------

  describe("with configured root folder", () => {
    let configDir: string;
    let c: Client;

    beforeEach(async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-"));
      await saveConfig(
        {
          markdown: {
            rootFolderId: "folder-1",
            rootFolderName: "Notes",
            rootFolderPath: "/Notes",
          },
        },
        configDir,
        testSignal(),
      );

      const auth = new MockAuthenticator({ token: "md-ops-token" });
      const server = await createMcpServer(
        {
          authenticator: auth,
          graphBaseUrl: env.graphUrl,
          configDir,
          openBrowser: () => Promise.reject(new Error("no browser in tests")),
        },
        testSignal(),
      );
      const [ct, st] = InMemoryTransport.createLinkedPair();
      c = new Client({ name: "test", version: "1.0" });
      await server.connect(st);
      await c.connect(ct);
    });

    afterEach(async () => {
      await rm(configDir, { recursive: true, force: true });
    });

    it("markdown_list_files returns only .md files with required fields", async () => {
      const r = (await c.callTool({
        name: "markdown_list_files",
        arguments: {},
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const text = firstText(r);
      expect(text).toContain("hello.md");
      expect(text).not.toContain("readme.txt");
      expect(text).toContain("file-md-1");
      expect(text).toMatch(/\d+ bytes/);
      expect(text).toContain("2026-04-10T11:00:00Z");
    });

    it("markdown_get_file by itemId returns content", async () => {
      const r = (await c.callTool({
        name: "markdown_get_file",
        arguments: { itemId: "file-md-1" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const text = firstText(r);
      expect(text).toContain("hello.md");
      expect(text).toContain("hello");
    });

    it("markdown_get_file by fileName works and is case-insensitive", async () => {
      const r = (await c.callTool({
        name: "markdown_get_file",
        arguments: { fileName: "HELLO.MD" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(firstText(r)).toContain("hello");
    });

    it("markdown_get_file requires itemId or fileName", async () => {
      const r = (await c.callTool({
        name: "markdown_get_file",
        arguments: {},
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain("Either itemId or fileName must be provided");
    });

    it("markdown_get_file returns a clear error for a missing file", async () => {
      const r = (await c.callTool({
        name: "markdown_get_file",
        arguments: { fileName: "missing.md" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain("not found");
    });

    it("markdown_create_file creates a new .md file and returns a cTag", async () => {
      const r = (await c.callTool({
        name: "markdown_create_file",
        arguments: { fileName: "brand-new.md", content: "# New\n" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const text = firstText(r);
      expect(text).toContain("brand-new.md");
      expect(text).toContain("cTag:");

      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const created = files.find((f) => f.name === "brand-new.md");
      expect(created).toBeDefined();
      expect(created!.content).toBe("# New\n");
      expect(created!.cTag).toBeTruthy();
    });

    it("markdown_create_file fails with a clear conflict error when the file already exists", async () => {
      const r = (await c.callTool({
        name: "markdown_create_file",
        arguments: { fileName: "hello.md", content: "x" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      const text = firstText(r);
      expect(text).toContain("already exists");
      expect(text).toContain("markdown_get_file");
      expect(text).toContain("markdown_update_file");

      // Existing content is unchanged.
      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const existing = files.find((f) => f.id === "file-md-1");
      expect(existing?.content).toBe("hello");
    });

    it("markdown_update_file overwrites an existing file when the cTag matches", async () => {
      // Read first to learn the current cTag.
      const get = (await c.callTool({
        name: "markdown_get_file",
        arguments: { fileName: "hello.md" },
      })) as ToolResult;
      const getText = firstText(get);
      const cTagMatch = /cTag: (".+?")/.exec(getText);
      expect(cTagMatch).not.toBeNull();
      const cTag = cTagMatch![1]!;

      const r = (await c.callTool({
        name: "markdown_update_file",
        arguments: { fileName: "hello.md", cTag, content: "overwritten" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const text = firstText(r);
      expect(text).toContain("Updated");
      expect(text).toContain("hello.md");
      expect(text).toContain("cTag:");

      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const updated = files.find((f) => f.id === "file-md-1");
      expect(updated?.content).toBe("overwritten");
      // cTag was bumped — no longer equal to the one we supplied.
      expect(updated?.cTag).toBeTruthy();
      expect(updated?.cTag).not.toBe(cTag);
      // No duplicate file entry was created
      expect(files.filter((f) => f.name.toLowerCase() === "hello.md")).toHaveLength(1);
    });

    it("markdown_update_file fails with reconcile guidance when the cTag is stale", async () => {
      // Snapshot the current cTag, then have something else update the file
      // (we'll do an in-test update that bumps the cTag).
      const get1 = (await c.callTool({
        name: "markdown_get_file",
        arguments: { fileName: "hello.md" },
      })) as ToolResult;
      const oldCTag = /cTag: (".+?")/.exec(firstText(get1))![1]!;

      const goodUpdate = (await c.callTool({
        name: "markdown_update_file",
        arguments: { fileName: "hello.md", cTag: oldCTag, content: "concurrent change" },
      })) as ToolResult;
      expect(goodUpdate.isError).toBeFalsy();

      // Now retry with the OLD cTag — should fail with structured reconcile guidance.
      const stale = (await c.callTool({
        name: "markdown_update_file",
        arguments: { fileName: "hello.md", cTag: oldCTag, content: "my stale write" },
      })) as ToolResult;
      expect(stale.isError).toBe(true);
      const text = firstText(stale);
      expect(text).toContain("modified since you last read it");
      expect(text).toContain("Supplied cTag:");
      expect(text).toContain("Current cTag:");
      expect(text).toContain("markdown_get_file");
      expect(text).toContain("reconcile");
      expect(text).toContain("ask the user");

      // Content is still the result of the earlier successful update, NOT
      // the stale write.
      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const file = files.find((f) => f.id === "file-md-1");
      expect(file?.content).toBe("concurrent change");
    });

    it("markdown_update_file by itemId works the same way", async () => {
      const get = (await c.callTool({
        name: "markdown_get_file",
        arguments: { itemId: "file-md-1" },
      })) as ToolResult;
      const cTag = /cTag: (".+?")/.exec(firstText(get))![1]!;

      const r = (await c.callTool({
        name: "markdown_update_file",
        arguments: { itemId: "file-md-1", cTag, content: "by-id update" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const file = files.find((f) => f.id === "file-md-1");
      expect(file?.content).toBe("by-id update");
    });

    it("markdown_update_file requires itemId or fileName", async () => {
      const r = (await c.callTool({
        name: "markdown_update_file",
        arguments: { cTag: "any", content: "x" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain("Either itemId or fileName must be provided");
    });

    it("markdown_create_file rejects non-.md file names via schema validation", async () => {
      const r = (await c.callTool({
        name: "markdown_create_file",
        arguments: { fileName: "readme.txt", content: "x" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain(".md");
    });

    it("markdown_create_file rejects payloads larger than 4 MiB", async () => {
      const oversized = "a".repeat(1024 * 1024).repeat(5); // 5 MiB
      const r = (await c.callTool({
        name: "markdown_create_file",
        arguments: { fileName: "big.md", content: oversized },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      const text = firstText(r);
      expect(text).toContain("4");
      expect(text.toLowerCase()).toContain("limit");
    });

    it("markdown_update_file rejects payloads larger than 4 MiB", async () => {
      const get = (await c.callTool({
        name: "markdown_get_file",
        arguments: { fileName: "hello.md" },
      })) as ToolResult;
      const cTag = /cTag: (".+?")/.exec(firstText(get))![1]!;
      const oversized = "a".repeat(1024 * 1024).repeat(5);
      const r = (await c.callTool({
        name: "markdown_update_file",
        arguments: { fileName: "hello.md", cTag, content: oversized },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      const text = firstText(r);
      expect(text).toContain("4");
      expect(text.toLowerCase()).toContain("limit");
    });

    it("markdown_delete_file by fileName deletes the file", async () => {
      const r = (await c.callTool({
        name: "markdown_delete_file",
        arguments: { fileName: "hello.md" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(firstText(r)).toContain("Deleted");

      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      expect(files.find((f) => f.id === "file-md-1")).toBeUndefined();
    });

    it("markdown_delete_file by itemId deletes the file", async () => {
      const r = (await c.callTool({
        name: "markdown_delete_file",
        arguments: { itemId: "file-md-1" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();

      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      expect(files.find((f) => f.id === "file-md-1")).toBeUndefined();
    });

    it("markdown_delete_file requires itemId or fileName", async () => {
      const r = (await c.callTool({
        name: "markdown_delete_file",
        arguments: {},
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain("Either itemId or fileName must be provided");
    });

    // -------------------------------------------------------------------
    // Strict naming enforcement
    // -------------------------------------------------------------------

    describe("strict file-name enforcement", () => {
      it("markdown_create_file rejects names with path separators (schema-level)", async () => {
        const r = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "sub/note.md", content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("path separator");
      });

      it("markdown_create_file rejects Windows reserved names", async () => {
        const r = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "CON.md", content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("reserved");
      });

      it("markdown_create_file rejects non-portable characters", async () => {
        const r = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "weird@name.md", content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("not portable");
      });

      it("markdown_create_file rejects names over 255 chars", async () => {
        const longName = `${"a".repeat(254)}.md`; // 256 chars total
        const r = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: longName, content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("maximum length");
      });

      it("markdown_update_file rejects unsafe names at the schema layer too", async () => {
        const r = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "sub/note.md", cTag: "any", content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("path separator");
      });

      it("markdown_get_file rejects unsafe names with a clear error", async () => {
        const r = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "../escape.md" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("path separator");
      });

      it("markdown_delete_file rejects unsafe names with a clear error", async () => {
        const r = (await c.callTool({
          name: "markdown_delete_file",
          arguments: { fileName: "sub/file.md" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("path separator");
      });

      it("markdown_list_files marks subdirectories and unsafe .md files as UNSUPPORTED", async () => {
        // Seed the configured folder with a subdirectory and an unsafe-named .md file.
        env.graphState.driveFolderChildren.set("folder-1", [
          // supported
          {
            id: "ok",
            name: "ok.md",
            size: 1,
            file: { mimeType: "text/markdown" },
            content: "x",
          },
          // subdirectory
          { id: "sub", name: "archive", folder: {} },
          // unsafe-named markdown
          {
            id: "bad",
            name: "bad name?.md",
            size: 1,
            file: { mimeType: "text/markdown" },
            content: "x",
          },
        ]);

        const r = (await c.callTool({
          name: "markdown_list_files",
          arguments: {},
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);

        // Supported file appears in the normal list
        expect(text).toContain("ok.md");

        // Subdirectory and unsafe-name file appear under UNSUPPORTED with a reason
        expect(text).toContain("UNSUPPORTED");
        expect(text).toContain("archive");
        expect(text).toContain("subdirectory");
        expect(text).toContain("bad name?.md");

        // Footer mentions both counts
        expect(text).toMatch(/Total:\s*1 supported, 2 unsupported/);
      });

      it("markdown_get_file by itemId refuses to download a subdirectory", async () => {
        env.graphState.driveFolderChildren.set("folder-1", [
          { id: "sub", name: "archive", folder: {} },
        ]);
        const r = (await c.callTool({
          name: "markdown_get_file",
          arguments: { itemId: "sub" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("subdirectory");
      });

      it("markdown_get_file by itemId refuses to download a file with an unsafe stored name", async () => {
        env.graphState.driveFolderChildren.set("folder-1", [
          {
            id: "bad",
            name: "bad name?.md",
            size: 1,
            file: { mimeType: "text/markdown" },
            content: "x",
          },
        ]);
        const r = (await c.callTool({
          name: "markdown_get_file",
          arguments: { itemId: "bad" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r)).toContain("cannot be read");
      });

      it("markdown_delete_file by itemId refuses to delete a subdirectory", async () => {
        env.graphState.driveFolderChildren.set("folder-1", [
          { id: "sub", name: "archive", folder: {} },
        ]);
        const r = (await c.callTool({
          name: "markdown_delete_file",
          arguments: { itemId: "sub" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("subdirectory");
      });
    });

    // -----------------------------------------------------------------------
    // Version history
    // -----------------------------------------------------------------------

    describe("version history", () => {
      it("markdown_list_file_versions shows the current version for an untouched file", async () => {
        // Real OneDrive includes the current version as the first entry even
        // when the file has never been overwritten.
        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("hello.md");
        expect(text).toMatch(/Total: 1 version\(s\)/);
      });

      it("markdown_list_file_versions lists current and historical snapshots after overwriting updates", async () => {
        // Two updates create two historical snapshots plus the current version.
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const cTag1 = /cTag: (".+?")/.exec(firstText(get1))![1]!;
        const upd1 = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: cTag1, content: "v2" },
        })) as ToolResult;
        const cTag2 = /cTag: (".+?")/.exec(firstText(upd1))![1]!;
        await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: cTag2, content: "v3" },
        });

        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("hello.md");
        // Current version (v3) + two historical snapshots (v2 + original).
        expect(text).toMatch(/Total: 3 version\(s\)/);
        expect(text).toContain("markdown_get_file_version");
      });

      it("markdown_get_file_version returns the historical content", async () => {
        const get = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const cTag = /cTag: (".+?")/.exec(firstText(get))![1]!;
        await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag, content: "updated" },
        });

        const list = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const listText = firstText(list);
        // After one overwrite: line 1 = current version, line 2 = prior snapshot.
        // Extract the second "2. <versionId> — ..." entry for the historical version.
        const match = /^2\. (\S+) —/m.exec(listText);
        expect(match).not.toBeNull();
        const versionId = match?.[1];
        if (!versionId) throw new Error("expected to parse a versionId from list output");

        const r = (await c.callTool({
          name: "markdown_get_file_version",
          arguments: { fileName: "hello.md", versionId },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const body = firstText(r);
        expect(body).toContain(`Version: ${versionId}`);
        // The original seeded content before the overwrite was "hello".
        expect(body).toContain("hello");
        expect(body).not.toContain("updated");
      });

      it("markdown_get_file_version errors with an unknown versionId", async () => {
        const r = (await c.callTool({
          name: "markdown_get_file_version",
          arguments: { fileName: "hello.md", versionId: "does-not-exist" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
      });

      it("markdown_get_file_version works when the current version id (from list) is supplied", async () => {
        // An agent may pick up the current version ID from markdown_list_file_versions
        // and then pass it to markdown_get_file_version. This should succeed by
        // falling back to the /content endpoint (OneDrive rejects /versions/{id}/content
        // for the current version).
        const list = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        // Line 1 is the current version (newest first).
        const match = /^1\. (\S+) —/m.exec(firstText(list));
        const currentVersionId = match?.[1];
        if (!currentVersionId) throw new Error("expected to parse a versionId from list output");

        const r = (await c.callTool({
          name: "markdown_get_file_version",
          arguments: { fileName: "hello.md", versionId: currentVersionId },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const body = firstText(r);
        expect(body).toContain(`Version: ${currentVersionId}`);
        expect(body).toContain("(current version content)");
        expect(body).not.toContain("historical content");
        expect(body).toContain("hello"); // seeded content
      });

      it("markdown_list_file_versions requires itemId or fileName", async () => {
        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: {},
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r)).toContain("Either itemId or fileName");
      });

      it("markdown_list_file_versions rejects a subdirectory", async () => {
        env.graphState.driveFolderChildren.set("folder-1", [
          { id: "sub", name: "archive", folder: {} },
        ]);
        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { itemId: "sub" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("subdirectory");
      });
    });

    // -----------------------------------------------------------------------
    // markdown_diff_file_versions + current-revision surfacing
    // -----------------------------------------------------------------------

    describe("current revision + diff", () => {
      function extract(label: string, text: string): string {
        // Lines look like `Revision: abc` / `Current Revision: abc` / `Current Revision:    abc`.
        const re = new RegExp(`${label}:\\s*(\\S+)`);
        const m = re.exec(text);
        if (!m?.[1]) throw new Error(`expected to find '${label}' in:\n${text}`);
        return m[1];
      }

      it("markdown_get_file surfaces a non-empty Revision", async () => {
        const r = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const rev = extract("Revision", firstText(r));
        expect(rev).not.toBe("(none)");
      });

      it("markdown_create_file surfaces a non-empty Revision", async () => {
        const r = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "brand-new.md", content: "hello" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        extract("Revision", firstText(r));
      });

      it("markdown_update_file bumps the Revision", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const get1Text = firstText(get1);
        const origRev = extract("Revision", get1Text);
        const cTag = extract("cTag", get1Text);

        const upd = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag, content: "body-v2" },
        })) as ToolResult;
        expect(upd.isError).toBeFalsy();
        const newRev = extract("Revision", firstText(upd));
        expect(newRev).not.toBe(origRev);
      });

      it("cTag-mismatch error surfaces the Current Revision and points at the diff tool", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const t1 = firstText(get1);
        const staleCTag = extract("cTag", t1);

        // Make a successful update to bump the revision.
        await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: staleCTag, content: "someone-elses-write" },
        });

        // Retry with the OLD cTag → 412 surfaced as agent-facing reconcile guidance.
        const stale = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: staleCTag, content: "my-intended-write" },
        })) as ToolResult;
        expect(stale.isError).toBe(true);
        const body = firstText(stale);
        expect(body).toContain("Current Revision:");
        expect(body).toContain("markdown_diff_file_versions");
        expect(body).toContain("fromVersionId");
        expect(body).toContain("toVersionId");
      });

      it("markdown_diff_file_versions produces a unified patch between historical and current", async () => {
        // Read the seeded file to learn its original revision.
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const t1 = firstText(get1);
        const origRev = extract("Revision", t1);
        const cTag = extract("cTag", t1);

        // Overwrite it.
        const upd = (await c.callTool({
          name: "markdown_update_file",
          arguments: {
            fileName: "hello.md",
            cTag,
            content: "hello world, with additions!",
          },
        })) as ToolResult;
        const newRev = extract("Revision", firstText(upd));

        // Diff the two revisions.
        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: {
            fileName: "hello.md",
            fromVersionId: origRev,
            toVersionId: newRev,
          },
        })) as ToolResult;
        expect(diff.isError).toBeFalsy();
        const body = firstText(diff);
        expect(body).toContain(`hello.md@${origRev}`);
        expect(body).toContain(`hello.md@${newRev}`);
        // Unified-diff header lines.
        expect(body).toMatch(/^---/m);
        expect(body).toMatch(/^\+\+\+/m);
        // The old body and the new body both appear with +/- markers.
        expect(body).toContain("-hello");
        expect(body).toContain("+hello world, with additions!");
      });

      it("markdown_diff_file_versions reports 'no content differences' when two revisions hold identical content", async () => {
        // Two updates with the same body produce two distinct revisions whose
        // content is identical.
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const cTag1 = extract("cTag", firstText(get1));

        const upd1 = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: cTag1, content: "identical" },
        })) as ToolResult;
        const rev1 = extract("Revision", firstText(upd1));
        const cTag2 = extract("cTag", firstText(upd1));

        const upd2 = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: cTag2, content: "identical" },
        })) as ToolResult;
        const rev2 = extract("Revision", firstText(upd2));

        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fileName: "hello.md", fromVersionId: rev1, toVersionId: rev2 },
        })) as ToolResult;
        expect(diff.isError).toBeFalsy();
        expect(firstText(diff)).toContain("no content differences");
      });

      it("markdown_diff_file_versions short-circuits when from and to are the same id", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const rev = extract("Revision", firstText(get1));

        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fileName: "hello.md", fromVersionId: rev, toVersionId: rev },
        })) as ToolResult;
        expect(diff.isError).toBeFalsy();
        expect(firstText(diff)).toContain("same");
      });

      it("markdown_diff_file_versions returns a clear error for an unknown revision id", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const rev = extract("Revision", firstText(get1));

        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fileName: "hello.md", fromVersionId: "nope", toVersionId: rev },
        })) as ToolResult;
        expect(diff.isError).toBe(true);
        const body = firstText(diff);
        expect(body).toContain("Version nope not found");
        expect(body).toContain("markdown_list_file_versions");
        expect(body).toContain("markdown_get_file");
      });

      it("markdown_diff_file_versions requires itemId or fileName", async () => {
        const r = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fromVersionId: "a", toVersionId: "b" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r)).toContain("Either itemId or fileName");
      });

      it("markdown_diff_file_versions rejects unsafe names at the schema layer", async () => {
        const r = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fileName: "../escape.md", fromVersionId: "a", toVersionId: "b" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("path separator");
      });

      it("markdown_diff_file_versions rejects a subdirectory", async () => {
        env.graphState.driveFolderChildren.set("folder-1", [
          { id: "sub", name: "archive", folder: {} },
        ]);
        const r = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { itemId: "sub", fromVersionId: "a", toVersionId: "b" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("subdirectory");
      });

      // ---------------------------------------------------------------------
      // Regression: production-typical "drive item omits version" path.
      //
      // Real OneDrive does not include `version` on `GET /me/drive/items/{id}`
      // (or on the response from a content upload), even though `/versions`
      // returns proper IDs. The mock mirrors this behaviour. Without the
      // /versions-fallback in `resolveCurrentRevision`, the agent-facing
      // Revision would read `(none)` / `(unknown)` and the cTag-mismatch
      // diff workflow would be unreachable. These tests lock in the
      // contract end-to-end so any future regression (re-introducing
      // `version` on the mock, or removing the fallback) fails loudly.
      // ---------------------------------------------------------------------

      it("regression: tool output does not leak the bare '(none)' / '(unknown)' placeholder when the drive item omits version", async () => {
        const get = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const getText = firstText(get);
        const cTag = extract("cTag", getText);

        const create = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "regression-new.md", content: "fresh" },
        })) as ToolResult;

        const upd = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag, content: "updated" },
        })) as ToolResult;

        for (const r of [get, create, upd]) {
          expect(r.isError).toBeFalsy();
          const text = firstText(r);
          // Old broken state: `Revision: (none)` (drive item didn't surface
          // version, no fallback) → unusable revision string.
          expect(text).not.toMatch(/Revision:\s*\(none\)/);
          // New unresolvable state would hint at list_file_versions; assert
          // the fallback succeeded so we get a real revision instead.
          expect(text).not.toMatch(/Revision:\s*\(unknown/);
        }
      });

      it("regression: Revision reported by markdown_get_file matches the current /versions entry returned by markdown_list_file_versions", async () => {
        const get = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const reportedRev = extract("Revision", firstText(get));

        const versions = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        // The list output renders revisions one per line; the current
        // version is the first (newest) entry. Ensure the bare ID appears
        // somewhere in the listing — and crucially is the same value that
        // markdown_get_file surfaced.
        expect(versions.isError).toBeFalsy();
        const versionsBody = firstText(versions);
        expect(versionsBody).toContain(reportedRev);
      });

      it("regression: Revision reported by markdown_create_file / markdown_update_file is usable as fromVersionId in markdown_diff_file_versions", async () => {
        // Create → revision A; update → revision B; diff(A, B) must work
        // end-to-end even though the underlying drive item omits `version`
        // on every Graph response.
        const create = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "regression-roundtrip.md", content: "v1\n" },
        })) as ToolResult;
        expect(create.isError).toBeFalsy();
        const revA = extract("Revision", firstText(create));
        const cTag = extract("cTag", firstText(create));

        const upd = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "regression-roundtrip.md", cTag, content: "v2\n" },
        })) as ToolResult;
        expect(upd.isError).toBeFalsy();
        const revB = extract("Revision", firstText(upd));
        expect(revB).not.toBe(revA);

        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: {
            fileName: "regression-roundtrip.md",
            fromVersionId: revA,
            toVersionId: revB,
          },
        })) as ToolResult;
        expect(diff.isError).toBeFalsy();
        const diffBody = firstText(diff);
        expect(diffBody).toContain("-v1");
        expect(diffBody).toContain("+v2");
      });

      it("regression: cTag-mismatch error surfaces a real Current Revision (not '(unknown)') even though Graph omits item.version", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const staleCTag = extract("cTag", firstText(get1));

        await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: staleCTag, content: "concurrent-write" },
        });

        const stale = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: staleCTag, content: "stale-write" },
        })) as ToolResult;
        expect(stale.isError).toBe(true);
        const body = firstText(stale);
        // The Current Revision line must carry an actual revision ID, not
        // a placeholder. Without the /versions fallback this would read
        // `Current Revision: (unknown)`.
        expect(body).toMatch(/Current Revision:\s+(?!\(unknown)\S/);
        const errRev = extract("Current Revision", body);
        // And it must be the same ID surfaced by /versions.
        const versions = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(firstText(versions)).toContain(errRev);
      });
    });

    describe("markdown_preview_file", () => {
      it("returns isError when the browser cannot be opened, but still surfaces the URL", async () => {
        // The shared `c` in this describe is wired with an openBrowser that
        // always rejects. Verify the tool degrades gracefully: no isError,
        // returns the SharePoint /my?id=... URL as text.
        const r = (await c.callTool({
          name: "markdown_preview_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("Could not open a browser automatically");
        expect(text).toContain("/my?id=");
        expect(text).toContain("%2FNotes%2Fhello.md");
        expect(text).toContain("parent=");
      });

      it("returns an error for an unknown file name", async () => {
        const r = (await c.callTool({
          name: "markdown_preview_file",
          arguments: { fileName: "missing.md" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r)).toContain("not found");
      });

      it("rejects unsafe names at the schema layer", async () => {
        const r = (await c.callTool({
          name: "markdown_preview_file",
          arguments: { fileName: "../escape.md" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("path separator");
      });
    });

    // ---------------------------------------------------------------------
    // markdown_edit
    // ---------------------------------------------------------------------

    describe("markdown_edit", () => {
      // Helper: replace the "hello" file with multi-line content so edit
      // tests can target specific anchors. Returns the new cTag the file
      // gets after the seed write.
      function seedHelloMd(content: string): void {
        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        if (!file) throw new Error("expected seeded hello.md to exist");
        file.content = content;
        file.size = Buffer.byteLength(content, "utf-8");
        // Force a fresh cTag so the next read sees a stable value.
        file.cTag = undefined;
      }

      function structured(r: ToolResult): {
        fileName?: string;
        itemId?: string;
        cTag?: string;
        sizeBytes?: number;
        editsApplied?: number;
      } {
        return (
          (r as ToolResult & { structuredContent?: Record<string, unknown> }).structuredContent ??
          {}
        );
      }

      it("applies a single edit, returns a unified diff and the new cTag", async () => {
        seedHelloMd("# Title\n\nfirst paragraph\n\nsecond paragraph\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "first paragraph", new_string: "FIRST paragraph" }],
          },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("Edited hello.md");
        expect(text).toContain("New cTag:");
        expect(text).toContain("Edits applied: 1");
        // Tight diff context (1) — should not include the "second paragraph" line.
        expect(text).toContain("-first paragraph");
        expect(text).toContain("+FIRST paragraph");
        expect(text).not.toContain("second paragraph");

        // Persisted content matches.
        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("# Title\n\nFIRST paragraph\n\nsecond paragraph\n");

        // structuredContent mirror is present and includes the new cTag.
        const sc = structured(r);
        expect(sc.fileName).toBe("hello.md");
        expect(sc.itemId).toBe("file-md-1");
        expect(typeof sc.cTag).toBe("string");
        expect(sc.cTag!.length).toBeGreaterThan(0);
        expect(sc.editsApplied).toBe(1);
        expect(sc.sizeBytes).toBe(Buffer.byteLength(file!.content!, "utf-8"));
      });

      it("applies multiple edits sequentially against the evolving content", async () => {
        seedHelloMd("alpha beta gamma\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [
              { old_string: "alpha", new_string: "ALPHA" },
              // Second edit must see the result of the first edit; we now
              // anchor on "ALPHA beta", proving sequential composition.
              { old_string: "ALPHA beta", new_string: "ALPHA BETA" },
            ],
          },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        expect(firstText(r)).toContain("Edits applied: 2");

        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("ALPHA BETA gamma\n");
      });

      it("replace_all: true replaces every occurrence", async () => {
        seedHelloMd("foo bar foo baz foo\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "foo", new_string: "QUX", replace_all: true }],
          },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();

        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("QUX bar QUX baz QUX\n");
      });

      it("replace_all: true with zero matches still fails (uniqueness rule, ADR-0006 decision 8)", async () => {
        seedHelloMd("nothing to see here\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "missing-anchor", new_string: "x", replace_all: true }],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        const text = firstText(r);
        expect(text).toContain("Edit #0:");
        expect(text).toContain("was not found");

        // Atomic: nothing was written.
        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("nothing to see here\n");
      });

      it("ambiguous match (multiple matches without replace_all) fails atomically", async () => {
        seedHelloMd("foo\nfoo\nfoo\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [
              { old_string: "should-still-match-once", new_string: "x" }, // dummy, won't be reached
              { old_string: "foo", new_string: "BAR" },
            ],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        const text = firstText(r);
        // Either edit could fail first; the first one fails with "not found",
        // so the multi-match edit (#1) should never run. Verify the
        // not-found path triggers and the error mentions Edit #0.
        expect(text).toContain("Edit #0:");
        expect(text).toContain("was not found");

        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("foo\nfoo\nfoo\n");
      });

      it("multi-match without replace_all reports the count and asks for replace_all or more context", async () => {
        seedHelloMd("foo\nfoo\nfoo\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "foo", new_string: "BAR" }],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        const text = firstText(r);
        expect(text).toContain("Edit #0:");
        expect(text).toContain("matched 3 locations");
        expect(text).toContain("replace_all: true");
      });

      it("no-match without replace_all reports the offending old_string verbatim", async () => {
        seedHelloMd("hello\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "goodbye", new_string: "x" }],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        const text = firstText(r);
        expect(text).toContain("Edit #0:");
        expect(text).toContain("was not found");
        expect(text).toContain('"goodbye"');
      });

      it("no-op edit (old_string === new_string) is rejected", async () => {
        seedHelloMd("hello\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "hello", new_string: "hello" }],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r)).toContain("identical");

        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("hello\n");
      });

      it("empty old_string is rejected at the schema layer", async () => {
        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "", new_string: "x" }],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        // Either the zod schema message (preferred) or the defence-in-depth
        // handler message — both name the empty old_string.
        const text = firstText(r).toLowerCase();
        expect(text).toContain("old_string");
        expect(text).toContain("empty");
      });

      it("CRLF in stored content and CRLF in old_string are normalised to LF", async () => {
        seedHelloMd("line one\r\nline two\r\nline three\r\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "line two\r\n", new_string: "LINE TWO\r\n" }],
          },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();

        // Persisted content is LF-only (no CR survives).
        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("line one\nLINE TWO\nline three\n");
        expect(file?.content).not.toContain("\r");
      });

      it("rejects post-edit content larger than 4 MiB before attempting the PUT", async () => {
        // Seed a small file so the read succeeds, then have an edit blow it
        // up past the cap by replacing a single anchor with 5 MiB of text.
        seedHelloMd("ANCHOR\n");
        const FOUR_MIB = 4 * 1024 * 1024;
        const oversized = "a".repeat(FOUR_MIB + 1);

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "ANCHOR", new_string: oversized }],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        const text = firstText(r);
        expect(text).toContain("exceeds");
        expect(text).toContain(String(FOUR_MIB));

        // Atomic: nothing was written.
        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("ANCHOR\n");
      });

      it("dry_run: true returns the diff without writing and omits cTag from structuredContent", async () => {
        seedHelloMd("hello world\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "hello world", new_string: "HELLO WORLD" }],
            dry_run: true,
          },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("(dry run");
        expect(text).toContain("-hello world");
        expect(text).toContain("+HELLO WORLD");
        // No new cTag in the text body.
        expect(text).not.toContain("New cTag:");

        // structuredContent mirror is present but cTag is omitted.
        const sc = structured(r);
        expect(sc.fileName).toBe("hello.md");
        expect(sc.itemId).toBe("file-md-1");
        expect(sc.cTag).toBeUndefined();
        expect(sc.editsApplied).toBe(1);

        // Nothing was persisted.
        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("hello world\n");
      });

      it("412 cTag mismatch surfaces edit-tool-specific reconcile guidance and does not write", async () => {
        seedHelloMd("alpha\n");

        // Simulate a concurrent writer mutating the file's cTag between
        // markdown_edit's own GET and PUT — the only realistic way to
        // produce a 412 within a single tool call. The pre-PUT hook fires
        // once, on the next PUT, and clears itself.
        env.graphState.prePutHook = (file): void => {
          file.cTag = `"c:{${file.id}},mutated-by-concurrent-writer"`;
        };

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "alpha", new_string: "beta" }],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        const text = firstText(r);
        expect(text).toContain("Edit rejected");
        expect(text).toContain("modified since markdown_edit started its own read");
        expect(text).toContain("were NOT applied");
        expect(text).toContain("Current cTag:");
        expect(text).toContain("markdown_get_file");
        expect(text).toContain("markdown_diff_file_versions");
        expect(text).toContain("ask the user");

        // Atomic: nothing was written.
        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("alpha\n");
      });

      it("two sequential markdown_edit calls succeed because the tool re-reads cTag every call", async () => {
        // Sanity: the tool does not assume a prior cTag is still current.
        seedHelloMd("alpha\n");

        const r1 = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "alpha", new_string: "beta" }],
          },
        })) as ToolResult;
        expect(r1.isError).toBeFalsy();

        const r2 = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            fileName: "hello.md",
            edits: [{ old_string: "beta", new_string: "gamma" }],
          },
        })) as ToolResult;
        expect(r2.isError).toBeFalsy();

        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("gamma\n");
      });

      it("requires itemId or fileName", async () => {
        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            edits: [{ old_string: "x", new_string: "y" }],
          },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r)).toContain("Either itemId or fileName must be provided");
      });

      it("edits by itemId work the same way", async () => {
        seedHelloMd("by-id-anchor\n");

        const r = (await c.callTool({
          name: "markdown_edit",
          arguments: {
            itemId: "file-md-1",
            edits: [{ old_string: "by-id-anchor", new_string: "by-id-replaced" }],
          },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const sc = structured(r);
        expect(sc.itemId).toBe("file-md-1");

        const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
        const file = files.find((f) => f.id === "file-md-1");
        expect(file?.content).toBe("by-id-replaced\n");
      });
    });
  });

  describe("markdown_preview_file (browser open succeeds)", () => {
    it("opens the SharePoint preview URL in the browser and returns it as text", async () => {
      const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-preview-"));
      try {
        await saveConfig(
          {
            markdown: {
              rootFolderId: "folder-1",
              rootFolderName: "Notes",
              rootFolderPath: "/Notes",
            },
          },
          tempConfigDir,
          testSignal(),
        );

        const opened: string[] = [];
        const browserSpy = (url: string): Promise<void> => {
          opened.push(url);
          return Promise.resolve();
        };

        const auth = new MockAuthenticator({ token: "md-preview-token" });
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
        const client = new Client({ name: "test", version: "1.0" });
        await server.connect(st);
        await client.connect(ct);

        const r = (await client.callTool({
          name: "markdown_preview_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();

        // Mock drive.webUrl =
        //   https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents
        // Item is hello.md inside the "Notes" folder (folder-1's name).
        const expectedUrl =
          "https://contoso-my.sharepoint.com/my" +
          "?id=%2Fpersonal%2Fuser_contoso_com%2FDocuments%2FNotes%2Fhello.md" +
          "&parent=%2Fpersonal%2Fuser_contoso_com%2FDocuments%2FNotes";
        expect(opened).toEqual([expectedUrl]);

        const text = firstText(r);
        expect(text).toContain("Opened");
        expect(text).toContain("hello.md");
        expect(text).toContain(expectedUrl);
      } finally {
        await rm(tempConfigDir, { recursive: true, force: true });
      }
    });
  });
});
