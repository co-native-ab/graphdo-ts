// Integration tests for tool discovery and login flow.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  firstText,
  MockAuthenticator,
  testSignal,
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
        "markdown_delete_file",
        "markdown_get_file",
        "markdown_get_file_version",
        "markdown_list_file_versions",
        "markdown_list_files",
        "markdown_select_root_folder",
        "markdown_upload_file",
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

    it("returns error when browser login fails", async () => {
      const failAuth = new MockAuthenticator({ browserLogin: false });
      const client = await createTestClient(env, failAuth);

      const result = (await client.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("Login failed");
    });

    it("scope-gated tools are disabled before login", async () => {
      const auth = new MockAuthenticator();
      await auth.logout(testSignal());
      const client = await createTestClient(env, auth);

      // Only always-enabled tools should be visible
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["auth_status", "login", "logout"]);
    });

    it("tools work after completing login", async () => {
      const browserAuth = new MockAuthenticator({ browserLogin: true });
      const client = await createTestClient(env, browserAuth);

      // Login via browser (completes immediately)
      const loginResult = (await client.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;
      expect(loginResult.isError).toBeFalsy();

      // Now tools should be visible and work
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toContain("mail_send");
      expect(names).toContain("todo_list");
      expect(names).toContain("logout");

      const result = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "Post-login test", body: "It works!" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("test@example.com");
    });

    it("logout disables scope-gated tools", async () => {
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

      // Only always-enabled tools should remain visible
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["auth_status", "login", "logout"]);
    });
  });
});
