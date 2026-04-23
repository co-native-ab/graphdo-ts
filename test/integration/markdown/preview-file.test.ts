// Integration tests: markdown_preview_file

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

describe("integration: markdown — markdown_preview_file", () => {
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
  });

  describe("markdown_preview_file (browser open succeeds)", () => {
    it("opens the SharePoint preview URL in the browser and returns it as text", async () => {
      const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-preview-"));
      try {
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
