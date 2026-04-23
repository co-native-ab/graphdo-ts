// Integration tests: markdown_append

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

describe("integration: markdown — markdown_append", () => {
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

    function seedHelloMd(content: string): void {
      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const file = files.find((f) => f.id === "file-md-1");
      if (!file) throw new Error("expected seeded hello.md to exist");
      file.content = content;
      file.size = Buffer.byteLength(content, "utf-8");
      // Force a fresh cTag so the next read sees a stable value.
      file.cTag = undefined;
    }

    function getFile(): { content?: string; cTag?: string } {
      const files = env.graphState.driveFolderChildren.get("folder-1") ?? [];
      const file = files.find((f) => f.id === "file-md-1");
      if (!file) throw new Error("expected seeded hello.md to exist");
      return file;
    }

    function structured(r: ToolResult): {
      fileName?: string;
      itemId?: string;
      cTag?: string;
      sizeBytes?: number;
      bytesAppended?: number;
      diff?: string;
    } {
      return (
        (r as ToolResult & { structuredContent?: Record<string, unknown> }).structuredContent ?? {}
      );
    }

    // -----------------------------------------------------------------
    // Happy path + structuredContent shape
    // -----------------------------------------------------------------

    it("appends content, returns a unified diff and the new cTag", async () => {
      seedHelloMd("# Title\n\nfirst paragraph\n");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "second paragraph\n" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();

      const text = firstText(r);
      expect(text).toContain("Appended to hello.md");
      expect(text).toContain("New cTag:");
      // Diff should show only the appended line under tight context.
      expect(text).toContain("+second paragraph");
      // The unchanged title should NOT appear in the diff body (tight
      // context = 1 means we only see the line immediately before the
      // first changed line).
      expect(text).not.toContain("# Title");

      // Persisted content matches.
      expect(getFile().content).toBe("# Title\n\nfirst paragraph\nsecond paragraph\n");

      // structuredContent mirror is present with the new cTag.
      const sc = structured(r);
      expect(sc.fileName).toBe("hello.md");
      expect(sc.itemId).toBe("file-md-1");
      expect(typeof sc.cTag).toBe("string");
      expect(sc.cTag!.length).toBeGreaterThan(0);
      expect(sc.bytesAppended).toBe(Buffer.byteLength("second paragraph\n", "utf-8"));
      expect(sc.sizeBytes).toBe(Buffer.byteLength(getFile().content!, "utf-8"));
      expect(typeof sc.diff).toBe("string");
      expect(sc.diff).toContain("+second paragraph");
    });

    // -----------------------------------------------------------------
    // Separator policy
    // -----------------------------------------------------------------

    it("auto-inserts one LF separator when the file does not end with a newline", async () => {
      seedHelloMd("no trailing newline");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "second line\n" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();

      // The single separator must be inserted exactly once — never two.
      expect(getFile().content).toBe("no trailing newline\nsecond line\n");
      // bytesAppended counts the separator + content.
      const sc = structured(r);
      expect(sc.bytesAppended).toBe(Buffer.byteLength("\nsecond line\n", "utf-8"));
    });

    it("does NOT insert a separator when the file already ends with a newline", async () => {
      seedHelloMd("first line\n");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "second line\n" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(getFile().content).toBe("first line\nsecond line\n");
      const sc = structured(r);
      expect(sc.bytesAppended).toBe(Buffer.byteLength("second line\n", "utf-8"));
    });

    it("does NOT insert a separator when the file is empty", async () => {
      seedHelloMd("");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "first line\n" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(getFile().content).toBe("first line\n");
      const sc = structured(r);
      expect(sc.bytesAppended).toBe(Buffer.byteLength("first line\n", "utf-8"));
    });

    it("preserves the absence of a trailing newline in `content` itself", async () => {
      seedHelloMd("first line\n");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "no trailing" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(getFile().content).toBe("first line\nno trailing");
    });

    // -----------------------------------------------------------------
    // Line-ending normalisation
    // -----------------------------------------------------------------

    it("normalises CRLF in stored content and CRLF in `content` to LF on the persisted result", async () => {
      seedHelloMd("line one\r\nline two\r\n");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "line three\r\nline four\r\n" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();

      // Persisted content is LF-only; no CR survives anywhere.
      expect(getFile().content).toBe("line one\nline two\nline three\nline four\n");
      expect(getFile().content).not.toContain("\r");
    });

    // -----------------------------------------------------------------
    // Validation errors
    // -----------------------------------------------------------------

    it("empty content is rejected at the schema layer", async () => {
      seedHelloMd("anything\n");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      const text = firstText(r).toLowerCase();
      expect(text).toContain("content");
      expect(text).toContain("empty");

      // Atomic: nothing was written.
      expect(getFile().content).toBe("anything\n");
    });

    it("requires itemId or fileName", async () => {
      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { content: "x" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain("Either itemId or fileName must be provided");
    });

    // -----------------------------------------------------------------
    // Size cap
    // -----------------------------------------------------------------

    it("rejects post-append content larger than 4 MiB before attempting the PUT", async () => {
      seedHelloMd("seed\n");
      const FOUR_MIB = 4 * 1024 * 1024;
      const oversized = "a".repeat(FOUR_MIB);

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: oversized },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      const text = firstText(r);
      expect(text).toContain("exceeds");
      expect(text).toContain(String(FOUR_MIB));

      // Atomic: nothing was written.
      expect(getFile().content).toBe("seed\n");
    });

    // -----------------------------------------------------------------
    // dry_run
    // -----------------------------------------------------------------

    it("dry_run: true returns the diff without writing and omits cTag from structuredContent", async () => {
      seedHelloMd("seed\n");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "preview\n", dry_run: true },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();

      const text = firstText(r);
      expect(text).toContain("(dry run");
      expect(text).toContain("+preview");
      // No new cTag in the text body.
      expect(text).not.toContain("New cTag:");

      const sc = structured(r);
      expect(sc.fileName).toBe("hello.md");
      expect(sc.itemId).toBe("file-md-1");
      expect(sc.cTag).toBeUndefined();
      expect(sc.bytesAppended).toBe(Buffer.byteLength("preview\n", "utf-8"));
      expect(typeof sc.diff).toBe("string");
      expect(sc.diff).toContain("+preview");

      // Nothing was persisted.
      expect(getFile().content).toBe("seed\n");
    });

    // -----------------------------------------------------------------
    // cTag mismatch
    // -----------------------------------------------------------------

    it("412 cTag mismatch surfaces append-tool-specific reconcile guidance and does not write", async () => {
      seedHelloMd("alpha\n");

      // Simulate a concurrent writer mutating the file's cTag between
      // markdown_append's own GET and PUT — the only realistic way to
      // produce a 412 within a single tool call.
      env.graphState.prePutHook = (file): void => {
        file.cTag = `"c:{${file.id}},mutated-by-concurrent-writer"`;
      };

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "beta\n" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      const text = firstText(r);
      expect(text).toContain("Append rejected");
      expect(text).toContain("modified since markdown_append started its own read");
      expect(text).toContain("was NOT applied");
      expect(text).toContain("Current cTag:");
      expect(text).toContain("markdown_get_file");
      expect(text).toContain("markdown_diff_file_versions");
      expect(text).toContain("ask the user");

      // Atomic: nothing was written.
      expect(getFile().content).toBe("alpha\n");
    });

    // -----------------------------------------------------------------
    // Sequential calls + itemId-based addressing
    // -----------------------------------------------------------------

    it("two sequential markdown_append calls succeed because the tool re-reads cTag every call", async () => {
      seedHelloMd("alpha\n");

      const r1 = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "beta\n" },
      })) as ToolResult;
      expect(r1.isError).toBeFalsy();

      const r2 = (await c.callTool({
        name: "markdown_append",
        arguments: { fileName: "hello.md", content: "gamma\n" },
      })) as ToolResult;
      expect(r2.isError).toBeFalsy();

      expect(getFile().content).toBe("alpha\nbeta\ngamma\n");
    });

    it("appends by itemId work the same way", async () => {
      seedHelloMd("by-id-seed\n");

      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { itemId: "file-md-1", content: "by-id-tail\n" },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const sc = structured(r);
      expect(sc.itemId).toBe("file-md-1");
      expect(getFile().content).toBe("by-id-seed\nby-id-tail\n");
    });

    // -----------------------------------------------------------------
    // Subdirectory / unsupported-name guards
    // -----------------------------------------------------------------

    it("refuses to append to a subdirectory", async () => {
      const r = (await c.callTool({
        name: "markdown_append",
        arguments: { itemId: "folder-2", content: "x\n" },
      })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(firstText(r)).toContain("subdirectory");
    });
  });
});
