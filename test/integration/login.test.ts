// Integration tests for tool discovery and login flow.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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
import { acquireFormSlot, resetFormFactoryForTest } from "../../src/tools/collab-forms.js";

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
        "collab_acquire_section",
        "collab_apply_proposal",
        "collab_create_proposal",
        "collab_delete_file",
        "collab_list_files",
        "collab_list_versions",
        "collab_read",
        "collab_release_section",
        "collab_restore_version",
        "collab_write",
        "login",
        "logout",
        "mail_send",
        "markdown_create_file",
        "markdown_delete_file",
        "markdown_diff_file_versions",
        "markdown_get_file",
        "markdown_get_file_version",
        "markdown_list_file_versions",
        "markdown_list_files",
        "markdown_preview_file",
        "markdown_select_root_folder",
        "markdown_update_file",
        "session_init_project",
        "session_open_project",
        "session_recover_doc_id",
        "session_renew",
        "session_status",
        "todo_add_step",
        "todo_complete",
        "todo_create",
        "todo_delete",
        "todo_delete_step",
        "todo_list",
        "todo_select_list",
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

  // -------------------------------------------------------------------------
  // Form-busy lock — F1 follow-up: logout also acquires the slot
  // -------------------------------------------------------------------------

  describe("form-busy lock", () => {
    afterEach(() => {
      // Belt-and-braces — release any slot left held if a test fails
      // before its own cleanup runs.
      resetFormFactoryForTest();
    });

    it("logout returns FormBusyError when another form holds the slot", async () => {
      const authed = new MockAuthenticator({ token: "still-valid" });
      const client = await createTestClient(env, authed);

      // Simulate another browser form (e.g. an in-flight todo_select_list
      // picker) holding the form-factory slot.
      const other = acquireFormSlot("todo_select_list");
      other.setUrl("http://127.0.0.1:54321");

      try {
        const result = (await client.callTool({
          name: "logout",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBe(true);
        const text = firstText(result);
        expect(text).toContain("Another approval form is already open");
        expect(text).toContain("http://127.0.0.1:54321");
        expect(text).toContain("todo_select_list");
      } finally {
        other.release();
      }

      // After the other form releases, logout works again.
      const ok = (await client.callTool({
        name: "logout",
        arguments: {},
      })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(firstText(ok)).toContain("Logged out");
    });

    it("logout short-circuits without acquiring the slot when not authenticated", async () => {
      const auth = new MockAuthenticator();
      await auth.logout(testSignal());
      const client = await createTestClient(env, auth);

      // Hold the slot from another form — the cheap "not logged in"
      // pre-check must not contend for the slot since it never opens
      // a browser.
      const other = acquireFormSlot("todo_select_list");
      other.setUrl("http://127.0.0.1:54321");

      try {
        const result = (await client.callTool({
          name: "logout",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain("Not logged in");
      } finally {
        other.release();
      }
    });
  });
});
