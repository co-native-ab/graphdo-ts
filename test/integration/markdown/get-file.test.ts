// Integration tests: markdown_get_file

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
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

describe("integration: markdown — markdown_get_file", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  beforeEach(() => {
    seedDrive(env);
  });

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

    it("markdown_get_file rejects unsafe names with a clear error", async () => {
      const r = (await c.callTool({
        name: "markdown_get_file",
        arguments: { fileName: "../escape.md" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r).toLowerCase()).toContain("path separator");
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
  });
});
