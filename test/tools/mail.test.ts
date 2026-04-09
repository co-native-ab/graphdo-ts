import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createTestEnv, type TestEnv } from "../helpers.js";

// ---------------------------------------------------------------------------
// Module-level mock: replace GRAPH_BASE_URL with a dynamic getter
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let graphUrl = "";
  return {
    getGraphUrl: () => graphUrl,
    setGraphUrl: (url: string) => {
      graphUrl = url;
    },
  };
});

vi.mock("../../src/index.js", () => ({
  get GRAPH_BASE_URL() {
    return mocks.getGraphUrl();
  },
  VERSION: "0.1.0",
}));

// Import tools AFTER the mock is registered
import { registerMailTools } from "../../src/tools/mail.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_INFO: AuthInfo = {
  token: "test-token",
  clientId: "test-client-id",
  scopes: ["Mail.Send"],
};

function patchTransportAuth(
  transport: InMemoryTransport,
  authInfo: AuthInfo,
): void {
  const originalSend = transport.send.bind(transport);
  transport.send = async (message, options) =>
    originalSend(message, { ...options, authInfo });
}

function textContent(result: Record<string, unknown>): string {
  const content = result["content"] as { type: string; text: string }[];
  const first = content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return first.text;
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "graphdo", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );
  registerMailTools(server);
  return server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mail_send tool", () => {
  let env: TestEnv;
  let client: Client;
  let mcpServer: McpServer;

  beforeEach(async () => {
    env = await createTestEnv();
    mocks.setGraphUrl(env.graphUrl);

    mcpServer = createServer();

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    patchTransportAuth(clientTransport, AUTH_INFO);

    await mcpServer.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    await env.cleanup();
  });

  it("sends email and returns success message", async () => {
    const result = await client.callTool({
      name: "mail_send",
      arguments: { subject: "Hello", body: "Hi there" },
    });

    expect(result.isError).toBeFalsy();
    expect(textContent(result)).toContain("Email sent to");
    expect(textContent(result)).toContain("test@example.com");
  });

  it("records correct mail in mock state", async () => {
    await client.callTool({
      name: "mail_send",
      arguments: { subject: "Test Subject", body: "Test body content" },
    });

    const mails = env.state.getSentMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("test@example.com");
    expect(mails[0]!.subject).toBe("Test Subject");
    expect(mails[0]!.body).toBe("Test body content");
    expect(mails[0]!.contentType).toBe("Text");
  });

  it("with html: true sets HTML content type", async () => {
    await client.callTool({
      name: "mail_send",
      arguments: { subject: "HTML Mail", body: "<b>bold</b>", html: true },
    });

    const mails = env.state.getSentMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.contentType).toBe("HTML");
  });

  it("without auth returns error", async () => {
    const noAuthServer = createServer();

    const [noAuthClientTransport, noAuthServerTransport] =
      InMemoryTransport.createLinkedPair();

    await noAuthServer.connect(noAuthServerTransport);

    const noAuthClient = new Client({
      name: "no-auth-client",
      version: "1.0",
    });
    await noAuthClient.connect(noAuthClientTransport);

    try {
      const result = await noAuthClient.callTool({
        name: "mail_send",
        arguments: { subject: "Hello", body: "Hi" },
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("Unauthorized");
    } finally {
      await noAuthClient.close();
      await noAuthServer.close();
    }
  });
});
