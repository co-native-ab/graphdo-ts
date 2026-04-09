// Tests for token validation.
// Uses mock-oidc.ts to generate RSA keys, serve JWKS, and sign test JWTs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteJWKSet, generateKeyPair } from "jose";

import {
  CLIENT_ID,
  GRAPH_AUDIENCE,
  TokenValidationError,
  createTokenValidator,
} from "../src/auth.js";
import type { ValidateTokenFn } from "../src/auth.js";
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
