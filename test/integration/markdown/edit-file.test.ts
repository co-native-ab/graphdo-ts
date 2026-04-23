// Integration tests: markdown_edit

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

describe("integration: markdown — markdown_edit", () => {
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
        diff?: string;
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
        // Unified diff is mirrored into structuredContent so MCP clients
        // that prioritise structuredContent over text content still
        // surface the diff to the agent.
        expect(typeof sc.diff).toBe("string");
        expect(sc.diff).toContain("-first paragraph");
        expect(sc.diff).toContain("+FIRST paragraph");
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
        // Diff is mirrored into structuredContent on dry_run too — the
        // whole point of dry_run is to preview the change.
        expect(typeof sc.diff).toBe("string");
        expect(sc.diff).toContain("-hello world");
        expect(sc.diff).toContain("+HELLO WORLD");

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
});
