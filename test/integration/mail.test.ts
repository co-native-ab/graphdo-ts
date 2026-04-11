// Integration tests for mail operations.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  firstText,
  MockAuthenticator,
  type IntegrationEnv,
  type ToolResult,
} from "./helpers.js";

let env: IntegrationEnv;

describe("integration: mail", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  it("sends mail to self", async () => {
    const auth = new MockAuthenticator({ token: "mail-token" });
    const client = await createTestClient(env, auth);
    env.graphState.sentMails = [];

    const result = (await client.callTool({
      name: "mail_send",
      arguments: { subject: "Test Subject", body: "Hello world" },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("test@example.com");

    // Verify in mock state
    expect(env.graphState.sentMails).toHaveLength(1);
    const mail = env.graphState.sentMails[0]!;
    expect(mail.subject).toBe("Test Subject");
    expect(mail.body).toBe("Hello world");
    expect(mail.to).toBe("test@example.com");
    expect(mail.contentType).toBe("Text");
  });

  it("sends HTML mail", async () => {
    const auth = new MockAuthenticator({ token: "mail-token" });
    const client = await createTestClient(env, auth);
    env.graphState.sentMails = [];

    const result = (await client.callTool({
      name: "mail_send",
      arguments: {
        subject: "HTML Email",
        body: "<h1>Hello</h1>",
        html: true,
      },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();

    const mail = env.graphState.sentMails[0]!;
    expect(mail.contentType).toBe("HTML");
    expect(mail.body).toBe("<h1>Hello</h1>");
  });
});
