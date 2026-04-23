// Integration tests: markdown_delete_file

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

describe("integration: markdown — markdown_delete_file", () => {
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
          workspace: {
            driveId: "me",
            itemId: "folder-1",
            driveName: "OneDrive",
            itemName: "Notes",
            itemPath: "/Notes",
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

    it("markdown_delete_file rejects unsafe names with a clear error", async () => {
      const r = (await c.callTool({
        name: "markdown_delete_file",
        arguments: { fileName: "sub/file.md" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r).toLowerCase()).toContain("path separator");
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
});
