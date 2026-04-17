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
  testSignal,
  saveConfig,
  loadConfig,
  type IntegrationEnv,
  type ToolResult,
} from "./helpers.js";

function seedDrive(env: IntegrationEnv): void {
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
      "markdown_upload_file",
      "markdown_delete_file",
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

  it("markdown_get_file, markdown_upload_file, markdown_delete_file all require configuration", async () => {
    const auth = new MockAuthenticator({ token: "md-token" });
    const c = await createTestClient(env, auth);

    for (const call of [
      { name: "markdown_get_file", arguments: { fileName: "x.md" } },
      { name: "markdown_upload_file", arguments: { fileName: "x.md", content: "x" } },
      { name: "markdown_delete_file", arguments: { fileName: "x.md" } },
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
        { name: "markdown_upload_file", arguments: { fileName: "x.md", content: "x" } },
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
          void fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "folder-2", label: "/Work" }),
          });
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
        setTimeout(() => {
          void fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "folder-1", label: "/Notes" }),
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
        setTimeout(() => {
          void fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "folder-1", label: "/Notes" }),
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

  it("markdown_select_root_folder preserves existing todo_config fields", async () => {
    const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-merge-"));
    try {
      await saveConfig(
        { todoListId: "keep-me", todoListName: "Keep Me" },
        tempConfigDir,
        testSignal(),
      );

      const browserSpy = (url: string): Promise<void> => {
        setTimeout(() => {
          void fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "folder-1", label: "/Notes" }),
          });
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

    it("markdown_upload_file creates a new .md file", async () => {
      const r = (await c.callTool({
        name: "markdown_upload_file",
        arguments: { fileName: "brand-new.md", content: "# New\n" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(firstText(r)).toContain("brand-new.md");

      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const created = files.find((f) => f.name === "brand-new.md");
      expect(created).toBeDefined();
      expect(created!.content).toBe("# New\n");
    });

    it("markdown_upload_file overwrites an existing file", async () => {
      const r = (await c.callTool({
        name: "markdown_upload_file",
        arguments: { fileName: "hello.md", content: "overwritten" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();

      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const updated = files.find((f) => f.id === "file-md-1");
      expect(updated?.content).toBe("overwritten");
      // No duplicate file entry was created
      expect(files.filter((f) => f.name.toLowerCase() === "hello.md")).toHaveLength(1);
    });

    it("markdown_upload_file rejects non-.md file names via schema validation", async () => {
      const r = (await c.callTool({
        name: "markdown_upload_file",
        arguments: { fileName: "readme.txt", content: "x" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain(".md");
    });

    it("markdown_upload_file rejects payloads larger than 4 MB", async () => {
      const oversized = "a".repeat(1024 * 1024).repeat(5); // 5 MiB
      const r = (await c.callTool({
        name: "markdown_upload_file",
        arguments: { fileName: "big.md", content: oversized },
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
      it("markdown_upload_file rejects names with path separators (schema-level)", async () => {
        const r = (await c.callTool({
          name: "markdown_upload_file",
          arguments: { fileName: "sub/note.md", content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("path separator");
      });

      it("markdown_upload_file rejects Windows reserved names", async () => {
        const r = (await c.callTool({
          name: "markdown_upload_file",
          arguments: { fileName: "CON.md", content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("reserved");
      });

      it("markdown_upload_file rejects non-portable characters", async () => {
        const r = (await c.callTool({
          name: "markdown_upload_file",
          arguments: { fileName: "weird@name.md", content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("not portable");
      });

      it("markdown_upload_file rejects names over 255 chars", async () => {
        const longName = `${"a".repeat(254)}.md`; // 256 chars total
        const r = (await c.callTool({
          name: "markdown_upload_file",
          arguments: { fileName: longName, content: "x" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("maximum length");
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
      it("markdown_list_file_versions returns no-prior-versions text for an untouched file", async () => {
        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("hello.md");
        expect(text.toLowerCase()).toContain("no prior versions");
      });

      it("markdown_list_file_versions lists snapshots created by overwriting uploads", async () => {
        // Overwrite hello.md twice so the mock produces two historical versions.
        await c.callTool({
          name: "markdown_upload_file",
          arguments: { fileName: "hello.md", content: "v2" },
        });
        await c.callTool({
          name: "markdown_upload_file",
          arguments: { fileName: "hello.md", content: "v3" },
        });

        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("hello.md");
        expect(text).toMatch(/Total: 2 version\(s\)/);
        expect(text).toContain("markdown_get_file_version");
      });

      it("markdown_get_file_version returns the historical content", async () => {
        await c.callTool({
          name: "markdown_upload_file",
          arguments: { fileName: "hello.md", content: "updated" },
        });

        const list = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const listText = firstText(list);
        // Extract the first "1. <versionId> — ..." entry.
        const match = /^1\. (\S+) —/m.exec(listText);
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
  });
});
