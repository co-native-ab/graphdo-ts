// Integration tests: markdown_create_file

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

describe("integration: markdown — markdown_create_file", () => {
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
  });
});
