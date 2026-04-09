// Tests for token validation and Protected Resource Metadata.
// Uses mock-oidc.ts to generate RSA keys, serve JWKS, and sign test JWTs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteJWKSet, generateKeyPair } from "jose";

import {
  AUTHORIZATION_SERVER,
  GRAPH_AUDIENCE,
  RESOURCE_SCOPES,
  TokenValidationError,
  createTokenValidator,
} from "../src/auth.js";
import type { ValidateTokenFn } from "../src/auth.js";
import { CLIENT_ID } from "../src/index.js";
import { createMockOIDC } from "./mock-oidc.js";
import type { MockOIDC } from "./mock-oidc.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let oidc: MockOIDC;
let validate: ValidateTokenFn;

beforeAll(async () => {
  oidc = await createMockOIDC();
  const jwks = createRemoteJWKSet(new URL(oidc.jwksUrl));
  validate = createTokenValidator(jwks, CLIENT_ID);
});

afterAll(async () => {
  await oidc.close();
});

// ---------------------------------------------------------------------------
// Token validation tests
// ---------------------------------------------------------------------------

describe("validateToken", () => {
  it("accepts a valid token", async () => {
    const token = await oidc.signToken();
    const claims = await validate(token);

    expect(claims.azp).toBe(CLIENT_ID);
    expect(claims.aud).toBe(GRAPH_AUDIENCE);
    expect(claims.iss).toMatch(/login\.microsoftonline\.com/);
    expect(claims.scp).toBe("Mail.Send Tasks.ReadWrite User.Read");
    expect(claims.sub).toBe(
      "test-user-00000000-0000-0000-0000-000000000099",
    );
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects an expired token", async () => {
    const token = await oidc.signToken({ expiresInSeconds: -3600 });
    await expect(validate(token)).rejects.toThrow(TokenValidationError);
    await expect(validate(token)).rejects.toThrow(/verification failed/i);
  });

  it("rejects a token signed with an unknown key", async () => {
    const { privateKey: wrongKey } = await generateKeyPair("RS256");
    const token = await oidc.signToken({
      signingKey: wrongKey,
      kid: "wrong-key",
    });
    await expect(validate(token)).rejects.toThrow(TokenValidationError);
    await expect(validate(token)).rejects.toThrow(/verification failed/i);
  });

  it("rejects a token with wrong issuer", async () => {
    const token = await oidc.signToken({
      iss: "https://evil.example.com/v2.0",
    });
    await expect(validate(token)).rejects.toThrow(TokenValidationError);
    await expect(validate(token)).rejects.toThrow(/Invalid issuer/i);
  });

  it("rejects a token with missing issuer", async () => {
    const token = await oidc.signToken({ iss: "" });
    await expect(validate(token)).rejects.toThrow(TokenValidationError);
    await expect(validate(token)).rejects.toThrow(/Invalid issuer/i);
  });

  it("rejects a token with wrong authorized party (azp)", async () => {
    const token = await oidc.signToken({
      azp: "wrong-client-id-00000000-0000-0000-0000",
    });
    await expect(validate(token)).rejects.toThrow(TokenValidationError);
    await expect(validate(token)).rejects.toThrow(/Invalid authorized party/i);
  });

  it("rejects a token with wrong audience", async () => {
    const token = await oidc.signToken({
      aud: "https://wrong-audience.example.com",
    });
    await expect(validate(token)).rejects.toThrow(TokenValidationError);
    await expect(validate(token)).rejects.toThrow(/verification failed/i);
  });

  it("rejects a malformed token", async () => {
    await expect(validate("not-a-jwt")).rejects.toThrow(
      TokenValidationError,
    );
    await expect(validate("")).rejects.toThrow(TokenValidationError);
    await expect(validate("a.b.c")).rejects.toThrow(TokenValidationError);
  });

  it("returns correct error code for invalid tokens", async () => {
    const token = await oidc.signToken({ expiresInSeconds: -3600 });
    try {
      await validate(token);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenValidationError);
      expect((err as TokenValidationError).code).toBe("invalid_token");
    }
  });

  it("accepts a token without scp claim", async () => {
    const token = await oidc.signToken({ scp: undefined });
    const claims = await validate(token);
    expect(claims.scp).toBeUndefined();
  });

  it("accepts tokens from different Azure AD tenants", async () => {
    const tenants = [
      "11111111-1111-1111-1111-111111111111",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "consumers",
    ];

    for (const tenant of tenants) {
      const token = await oidc.signToken({
        iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
      });
      const claims = await validate(token);
      expect(claims.iss).toContain(tenant);
    }
  });
});

// ---------------------------------------------------------------------------
// Protected Resource Metadata endpoint tests
// ---------------------------------------------------------------------------

describe("Protected Resource Metadata endpoint", () => {
  let serverUrl: string;
  let httpServer: import("node:http").Server;

  /** Standard MCP headers for POST requests. */
  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  /** Send an MCP initialize request and return the session ID. */
  async function initSession(): Promise<string> {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (!sid) throw new Error(`init failed: status=${res.status}`);
    return sid;
  }

  beforeAll(async () => {
    const { startServer } = await import("../src/index.js");
    const jwks = createRemoteJWKSet(new URL(oidc.jwksUrl));
    const mockValidator = createTokenValidator(jwks, CLIENT_ID);

    process.env["PORT"] = "0";
    httpServer = await startServer({ validateToken: mockValidator });
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    serverUrl = `http://localhost:${String(port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    delete process.env["PORT"];
  });

  it("serves metadata at /.well-known/oauth-protected-resource", async () => {
    const res = await fetch(
      `${serverUrl}/.well-known/oauth-protected-resource`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const metadata = (await res.json()) as Record<string, unknown>;
    expect(metadata["resource"]).toBe(serverUrl);
    expect(metadata["authorization_servers"]).toEqual([
      AUTHORIZATION_SERVER,
    ]);
    expect(metadata["scopes_supported"]).toEqual([...RESOURCE_SCOPES]);
    expect(metadata["bearer_methods_supported"]).toEqual(["header"]);
  });

  it("serves metadata at path-based variant /mcp", async () => {
    const res = await fetch(
      `${serverUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(res.status).toBe(200);

    const metadata = (await res.json()) as Record<string, unknown>;
    expect(metadata["authorization_servers"]).toEqual([
      AUTHORIZATION_SERVER,
    ]);
  });

  it("returns 401 with resource_metadata for missing token on existing session", async () => {
    const sessionId = await initSession();

    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 2,
      }),
    });

    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
    expect(wwwAuth).toContain('scope="Mail.Send Tasks.ReadWrite User.Read"');
    expect(wwwAuth).not.toContain("offline_access");
  });

  it("returns 401 with resource_metadata for invalid token", async () => {
    const sessionId = await initSession();

    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        "mcp-session-id": sessionId,
        Authorization: "Bearer invalid-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 3,
      }),
    });

    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain('scope="Mail.Send Tasks.ReadWrite User.Read"');
  });

  it("accepts a valid token on existing session", async () => {
    const sessionId = await initSession();
    const validToken = await oidc.signToken();

    // Send initialized notification
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        "mcp-session-id": sessionId,
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    // Notifications return 202 Accepted
    expect(res.status).toBe(202);
  });

  it("allows initialization without a token", async () => {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 99,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });
});
