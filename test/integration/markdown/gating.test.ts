// Integration tests: markdown scope gating and "not configured" errors

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
  testSignal,
  saveConfig,
  type IntegrationEnv,
  type ToolResult,
} from "../helpers.js";
import { seedDrive } from "./_helpers.js";

let env: IntegrationEnv;

describe("integration: markdown gating", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  beforeEach(() => {
    seedDrive(env);
  });

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
});
