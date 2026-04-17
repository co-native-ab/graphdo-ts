// Integration tests for dynamic scope-based tool visibility.
//
// Verifies that tools are enabled/disabled based on the scopes granted
// to the MockAuthenticator, covering various scope combinations.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GraphScope } from "../../src/scopes.js";
import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  MockAuthenticator,
  testSignal,
  type IntegrationEnv,
} from "./helpers.js";

let env: IntegrationEnv;

describe("integration: dynamic tool state", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  async function toolNames(auth: MockAuthenticator): Promise<string[]> {
    const client = await createTestClient(env, auth);
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  }

  // -------------------------------------------------------------------------
  // Unauthenticated state
  // -------------------------------------------------------------------------

  it("unauthenticated: only login and auth_status visible", async () => {
    const auth = new MockAuthenticator();
    await auth.logout(testSignal()); // ensure unauthenticated
    const names = await toolNames(auth);
    expect(names).toEqual(["auth_status", "login", "logout"]);
  });

  // -------------------------------------------------------------------------
  // All scopes granted
  // -------------------------------------------------------------------------

  it("all scopes: all tools visible", async () => {
    const auth = new MockAuthenticator({ token: "full-access" });
    const names = await toolNames(auth);
    expect(names).toContain("login");
    expect(names).toContain("auth_status");
    expect(names).toContain("logout");
    expect(names).toContain("mail_send");
    expect(names).toContain("todo_list");
    expect(names).toContain("todo_show");
    expect(names).toContain("todo_create");
    expect(names).toContain("todo_update");
    expect(names).toContain("todo_complete");
    expect(names).toContain("todo_delete");
    expect(names).toContain("todo_steps");
    expect(names).toContain("todo_add_step");
    expect(names).toContain("todo_update_step");
    expect(names).toContain("todo_delete_step");
    expect(names).toContain("todo_config");
    expect(names).toContain("markdown_select_root_folder");
    expect(names).toContain("markdown_list_files");
    expect(names).toContain("markdown_get_file");
    expect(names).toContain("markdown_upload_file");
    expect(names).toContain("markdown_delete_file");
    expect(names).toContain("markdown_list_file_versions");
    expect(names).toContain("markdown_get_file_version");
    expect(names).toHaveLength(22);
  });

  // -------------------------------------------------------------------------
  // Mail.Send only
  // -------------------------------------------------------------------------

  it("MailSend + UserRead: only mail and always-enabled tools", async () => {
    const auth = new MockAuthenticator({
      token: "mail-only",
      grantedScopes: [GraphScope.MailSend, GraphScope.UserRead, GraphScope.OfflineAccess],
    });
    const names = await toolNames(auth);
    expect(names).toEqual(["auth_status", "login", "logout", "mail_send"]);
  });

  // -------------------------------------------------------------------------
  // Tasks.ReadWrite only
  // -------------------------------------------------------------------------

  it("TasksReadWrite + UserRead: all todo tools but no mail", async () => {
    const auth = new MockAuthenticator({
      token: "tasks-rw",
      grantedScopes: [GraphScope.TasksReadWrite, GraphScope.UserRead, GraphScope.OfflineAccess],
    });
    const names = await toolNames(auth);
    expect(names).toContain("todo_list");
    expect(names).toContain("todo_show");
    expect(names).toContain("todo_create");
    expect(names).toContain("todo_update");
    expect(names).toContain("todo_complete");
    expect(names).toContain("todo_delete");
    expect(names).toContain("todo_steps");
    expect(names).toContain("todo_add_step");
    expect(names).toContain("todo_update_step");
    expect(names).toContain("todo_delete_step");
    expect(names).toContain("todo_config");
    expect(names).not.toContain("mail_send");
  });

  // -------------------------------------------------------------------------
  // UserRead only (no mail, no tasks)
  // -------------------------------------------------------------------------

  it("UserRead only: only always-enabled + logout", async () => {
    const auth = new MockAuthenticator({
      token: "user-only",
      grantedScopes: [GraphScope.UserRead, GraphScope.OfflineAccess],
    });
    const names = await toolNames(auth);
    expect(names).toEqual(["auth_status", "login", "logout"]);
  });

  // -------------------------------------------------------------------------
  // Login/logout cycle changes tool visibility
  // -------------------------------------------------------------------------

  it("login enables tools and logout disables them", async () => {
    const auth = new MockAuthenticator({
      browserLogin: true,
      grantedScopes: [GraphScope.MailSend, GraphScope.UserRead, GraphScope.OfflineAccess],
    });
    const client = await createTestClient(env, auth);

    // Before login: minimal tools
    const before = await client.listTools();
    expect(before.tools.map((t) => t.name).sort()).toEqual(["auth_status", "login", "logout"]);

    // Login
    await client.callTool({ name: "login", arguments: {} });

    // After login: mail tools appear
    const after = await client.listTools();
    const afterNames = after.tools.map((t) => t.name).sort();
    expect(afterNames).toContain("mail_send");
    expect(afterNames).toContain("logout");

    // Logout
    await client.callTool({ name: "logout", arguments: {} });

    // After logout: back to minimal
    const final = await client.listTools();
    expect(final.tools.map((t) => t.name).sort()).toEqual(["auth_status", "login", "logout"]);
  });
});
