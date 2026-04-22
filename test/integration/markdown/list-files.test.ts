// Integration tests: markdown_list_files

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

describe("integration: markdown — markdown_list_files", () => {
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
  });
});
