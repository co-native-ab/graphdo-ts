// Mock OpenID Connect provider for testing JWT token validation.
// Generates RSA keys, serves JWKS over HTTP, and signs test tokens.

import { createServer, type Server } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";

import { GRAPH_AUDIENCE, CLIENT_ID } from "../src/auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_ISSUER = `https://login.microsoftonline.com/${TEST_TENANT_ID}/v2.0`;
const DEFAULT_SCOPES = "Mail.Send Tasks.ReadWrite User.Read";
const DEFAULT_SUBJECT = "test-user-00000000-0000-0000-0000-000000000099";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockOIDC {
  /** Base URL of the mock OIDC server (e.g. http://localhost:12345). */
  url: string;
  /** URL to the JWKS endpoint. */
  jwksUrl: string;
  /** The RSA private key used to sign tokens. */
  privateKey: CryptoKey;
  /** The underlying HTTP server. */
  server: Server;
  /**
   * Sign a JWT with the mock provider's key.
   * By default produces a valid Azure AD-like token. Pass overrides to test
   * specific failure scenarios (wrong issuer, expired, wrong azp, etc.).
   */
  signToken: (overrides?: TokenOverrides) => Promise<string>;
  /** Shut down the mock server. */
  close: () => Promise<void>;
}

export interface TokenOverrides {
  /** Override the issuer claim. */
  iss?: string;
  /** Override the audience claim. */
  aud?: string;
  /** Override the authorized party (azp) claim. */
  azp?: string;
  /** Override the subject claim. */
  sub?: string;
  /** Override the scopes (scp) claim. */
  scp?: string;
  /** Override expiration (seconds from now, negative = already expired). */
  expiresInSeconds?: number;
  /** Sign with a different key (e.g. for wrong-key tests). */
  signingKey?: CryptoKey;
  /** Use a different kid in the header. */
  kid?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a mock OIDC provider that serves JWKS over HTTP and signs test JWTs.
 *
 * Usage:
 * ```ts
 * const oidc = await createMockOIDC();
 * const token = await oidc.signToken();           // valid token
 * const expired = await oidc.signToken({ expiresInSeconds: -3600 });
 * await oidc.close();
 * ```
 */
export async function createMockOIDC(): Promise<MockOIDC> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = await exportJWK(publicKey);
  jwk.kid = "test-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const jwksDocument = { keys: [jwk] };

  const server = createServer((req, res) => {
    // JWKS endpoint (both common paths)
    if (
      req.url === "/discovery/v2.0/keys" ||
      req.url === "/.well-known/jwks.json"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jwksDocument));
      return;
    }

    // OpenID Configuration
    if (req.url === "/.well-known/openid-configuration") {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${String(port)}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: DEFAULT_ISSUER,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          jwks_uri: `${baseUrl}/.well-known/jwks.json`,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://localhost:${String(port)}`;

  return {
    url,
    jwksUrl: `${url}/.well-known/jwks.json`,
    privateKey,
    server,

    signToken: async (overrides?: TokenOverrides): Promise<string> => {
      const key: CryptoKey = overrides?.signingKey ?? privateKey;
      const kid = overrides?.kid ?? "test-key-1";
      const expiresIn = overrides?.expiresInSeconds ?? 3600;

      const now = Math.floor(Date.now() / 1000);

      // Build payload, omitting scp if explicitly set to undefined
      const payload: Record<string, unknown> = {
        azp: overrides?.azp ?? CLIENT_ID,
      };
      const scp =
        overrides && "scp" in overrides ? overrides.scp : DEFAULT_SCOPES;
      if (scp !== undefined) {
        payload["scp"] = scp;
      }

      const builder = new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuedAt(now)
        .setExpirationTime(now + expiresIn)
        .setNotBefore(now - 10)
        .setIssuer(overrides?.iss ?? DEFAULT_ISSUER)
        .setAudience(overrides?.aud ?? GRAPH_AUDIENCE)
        .setSubject(overrides?.sub ?? DEFAULT_SUBJECT);

      return builder.sign(key);
    },

    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
