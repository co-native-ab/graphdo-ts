// Integration tests: markdown_select_workspace browser navigator.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  firstText,
  MockAuthenticator,
  createMcpServer,
  InMemoryTransport,
  Client,
  fetchCsrfToken,
  testSignal,
  loadConfig,
  type IntegrationEnv,
  type ToolResult,
} from "../helpers.js";
import { seedDrive } from "./_helpers.js";

let env: IntegrationEnv;

describe("integration: markdown_select_workspace", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  beforeEach(() => {
    seedDrive(env);
  });

  it("navigates the user's OneDrive and persists the chosen folder as the workspace", async () => {
    const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-e2e-"));

    try {
      let capturedUrl = "";
      const browserSpy = (url: string): Promise<void> => {
        capturedUrl = url;
        // Simulate the user clicking through the navigator: load the root
        // folder listing, then POST /select with the folder of choice. The
        // navigator does not require us to actually walk into a subfolder
        // first — selecting a top-level child by id works the same way the
        // page would after a single click.
        setTimeout(() => {
          void (async () => {
            const csrfToken = await fetchCsrfToken(url);
            // Confirm the page renders the drive switcher with the user's drive.
            const html = await fetch(url).then((r) => r.text());
            if (!html.includes("OneDrive")) {
              throw new Error("navigator HTML missing OneDrive tab");
            }
            // POST /select directly — the navigator's onSelect persists.
            await fetch(`${url}/select`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                driveId: "me",
                itemId: "folder-2",
                itemName: "Work",
                itemPath: "/Work",
                csrfToken,
              }),
            });
          })();
        }, 100);
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
        name: "markdown_select_workspace",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("browser window has been opened");
      expect(text).toContain("folder-2");
      expect(capturedUrl).toContain("http://127.0.0.1:");

      const cfg = await loadConfig(tempConfigDir, testSignal());
      expect(cfg?.workspace?.driveId).toBe("me");
      expect(cfg?.workspace?.itemId).toBe("folder-2");
      expect(cfg?.workspace?.itemName).toBe("Work");
      expect(cfg?.workspace?.itemPath).toBe("/Work");
    } finally {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("returns the URL when the browser cannot be opened (headless / remote)", async () => {
    const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-e2e-"));
    try {
      let capturedUrl = "";
      const browserSpy = (url: string): Promise<void> => {
        capturedUrl = url;
        // Same as above but reject openBrowser to simulate headless.
        setTimeout(() => {
          void (async () => {
            const csrfToken = await fetchCsrfToken(url);
            await fetch(`${url}/select`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                driveId: "me",
                itemId: "folder-1",
                itemName: "Notes",
                itemPath: "/Notes",
                csrfToken,
              }),
            });
          })();
        }, 100);
        return Promise.reject(new Error("headless"));
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
        name: "markdown_select_workspace",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("Could not open a browser automatically");
      expect(text).toContain(capturedUrl);

      const cfg = await loadConfig(tempConfigDir, testSignal());
      expect(cfg?.workspace?.itemId).toBe("folder-1");
    } finally {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });
});
