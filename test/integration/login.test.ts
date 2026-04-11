// Integration tests for tool discovery and login flow.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  createElicitingClient,
  firstText,
  MockAuthenticator,
  type IntegrationEnv,
  type ToolResult,
} from "./helpers.js";

let env: IntegrationEnv;

describe("integration: discovery & login", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  // -------------------------------------------------------------------------
  // Tool discovery
  // -------------------------------------------------------------------------

  describe("tool discovery", () => {
    it("lists all expected tools", async () => {
      const auth = new MockAuthenticator({ token: "discovery-token" });
      const client = await createTestClient(env, auth);

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      expect(names).toEqual([
        "auth_status",
        "login",
        "logout",
        "mail_send",
        "todo_add_step",
        "todo_complete",
        "todo_config",
        "todo_create",
        "todo_delete",
        "todo_delete_step",
        "todo_list",
        "todo_show",
        "todo_steps",
        "todo_update",
        "todo_update_step",
      ]);
    });

    it("each tool has a description", async () => {
      const auth = new MockAuthenticator({ token: "discovery-token" });
      const client = await createTestClient(env, auth);

      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Login flow
  // -------------------------------------------------------------------------

  describe("login flow", () => {
    let auth: MockAuthenticator;

    beforeEach(() => {
      auth = new MockAuthenticator();
    });

    it("login triggers device code flow and returns pending message", async () => {
      const client = await createTestClient(env, auth);
      const result = (await client.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("microsoft.com/devicelogin");
      expect(text).toContain("MOCK1234");
      expect(text).toContain("Once you've signed in");

      // Login should be pending
      expect(auth.loginPending).toBe(true);
    });

    it("completes immediately with browser login", async () => {
      const browserAuth = new MockAuthenticator({ browserLogin: true });
      const c = await createTestClient(env, browserAuth);

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("Logged in as");
      expect(text).toContain("test@example.com");

      // No pending login - completed immediately
      expect(browserAuth.loginPending).toBe(false);
    });

    it("already logged in returns friendly message", async () => {
      const authed = new MockAuthenticator({ token: "existing-token" });
      const client = await createTestClient(env, authed);

      const result = (await client.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Already logged in");
    });

    it("tools fail before login", async () => {
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "Test", body: "Test body" },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("Not logged in");
    });

    it("tools work after completing login", async () => {
      const client = await createTestClient(env, auth);

      // Start login
      await client.callTool({ name: "login", arguments: {} });
      expect(auth.loginPending).toBe(true);

      // Simulate user completing device code flow
      auth.completeLogin("test-access-token");

      // Now tools should work (token() will await the pending login)
      const result = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "Post-login test", body: "It works!" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("test@example.com");
    });

    it("logout clears auth and tools fail again", async () => {
      // Start authenticated
      const authed = new MockAuthenticator({ token: "will-be-cleared" });
      const client = await createTestClient(env, authed);

      // Verify tools work
      const before = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "Before logout", body: "Works" },
      })) as ToolResult;
      expect(before.isError).toBeFalsy();

      // Logout
      const logoutResult = (await client.callTool({
        name: "logout",
        arguments: {},
      })) as ToolResult;
      expect(logoutResult.isError).toBeFalsy();
      expect(firstText(logoutResult)).toContain("Logged out");

      // Tools should fail now
      const after = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "After logout", body: "Fails" },
      })) as ToolResult;
      expect(after.isError).toBe(true);
      expect(firstText(after)).toContain("Not logged in");
    });
  });

  // -------------------------------------------------------------------------
  // Elicitation: login
  // -------------------------------------------------------------------------

  describe("elicitation: login", () => {
    it("uses form elicitation when client supports it", async () => {
      const elicitAuth = new MockAuthenticator();
      let elicitMessage = "";

      const c = await createElicitingClient(env, elicitAuth, (params) => {
        elicitMessage = params.message;
        // Simulate user completing sign-in
        elicitAuth.completeLogin("elicit-token");
        return { action: "accept", content: { confirmed: true } };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Logged in successfully");
      expect(elicitMessage).toContain("microsoft.com/devicelogin");
      expect(elicitMessage).toContain("MOCK1234");
    });

    it("handles elicitation decline", async () => {
      const elicitAuth = new MockAuthenticator();
      const c = await createElicitingClient(env, elicitAuth, () => {
        return { action: "decline" };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("cancelled");
    });

    it("handles elicitation cancel", async () => {
      const elicitAuth = new MockAuthenticator();
      const c = await createElicitingClient(env, elicitAuth, () => {
        return { action: "cancel" };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("cancelled");
    });

    it("falls back to text when client lacks elicitation", async () => {
      const noElicitAuth = new MockAuthenticator();
      const c = await createTestClient(env, noElicitAuth);

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("microsoft.com/devicelogin");
      expect(text).toContain("Once you've signed in");
    });

    it("skips elicitation when already authenticated", async () => {
      let elicitCalled = false;
      const authedAuth = new MockAuthenticator({ token: "already-authed" });
      const c = await createElicitingClient(env, authedAuth, () => {
        elicitCalled = true;
        return { action: "accept", content: {} };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Already logged in");
      expect(elicitCalled).toBe(false);
    });

    it("skips elicitation when browser login completes immediately", async () => {
      let elicitCalled = false;
      const browserAuth = new MockAuthenticator({ browserLogin: true });
      const c = await createElicitingClient(env, browserAuth, () => {
        elicitCalled = true;
        return { action: "accept", content: {} };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Logged in as");
      expect(elicitCalled).toBe(false);
    });
  });
});
