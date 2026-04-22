// Integration tests: markdown_update_file

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

describe("integration: markdown — markdown_update_file", () => {
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

    it("markdown_update_file rejects unsafe names at the schema layer too", async () => {
      const r = (await c.callTool({
        name: "markdown_update_file",
        arguments: { fileName: "sub/note.md", cTag: "any", content: "x" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r).toLowerCase()).toContain("path separator");
    });
  });
});
