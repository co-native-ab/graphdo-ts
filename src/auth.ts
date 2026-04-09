// Token validation for Azure AD JWT access tokens.
// Uses jose (RFC 7515/7517/7519) for JWT verification against Azure AD JWKS.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AUTHORIZATION_SERVER =
  "https://login.microsoftonline.com/common/v2.0";

export const JWKS_URL = new URL(
  "https://login.microsoftonline.com/common/discovery/v2.0/keys",
);

export const GRAPH_AUDIENCE = "https://graph.microsoft.com";

/** Scopes for Protected Resource Metadata (excludes offline_access per spec). */
export const RESOURCE_SCOPES: readonly string[] = [
  "Mail.Send",
  "Tasks.ReadWrite",
  "User.Read",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenClaims {
  /** Subject (user ID) */
  sub: string;
  /** Issuer (Azure AD tenant-specific) */
  iss: string;
  /** Audience (should be https://graph.microsoft.com) */
  aud: string;
  /** Authorized party (client ID that requested the token) */
  azp: string;
  /** Scopes as space-separated string */
  scp: string | undefined;
  /** Expiration timestamp (seconds since epoch) */
  exp: number;
  /** Full JWT payload for additional claims */
  raw: JWTPayload;
}

export class TokenValidationError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_token" | "insufficient_scope",
  ) {
    super(message);
    this.name = "TokenValidationError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Azure AD v2.0 issuer: https://login.microsoftonline.com/{tenant}/v2.0 */
const AZURE_AD_ISSUER_PATTERN =
  /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/;

export type ValidateTokenFn = (token: string) => Promise<TokenClaims>;

/**
 * Create a token validator backed by a JWKS key source.
 *
 * @param getKey   A JWKS key resolver (from createRemoteJWKSet or createLocalJWKSet).
 * @param clientId The expected `azp` claim value (our app registration).
 * @param options  Optional overrides for audience and issuer pattern (useful in tests).
 */
export function createTokenValidator(
  getKey: JWTVerifyGetKey,
  clientId: string,
  options?: {
    audience?: string;
    issuerPattern?: RegExp;
  },
): ValidateTokenFn {
  const audience = options?.audience ?? GRAPH_AUDIENCE;
  const issuerPattern = options?.issuerPattern ?? AZURE_AD_ISSUER_PATTERN;

  return async function validateToken(token: string): Promise<TokenClaims> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, getKey, { audience });
      payload = result.payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("token verification failed", { error: msg });
      throw new TokenValidationError(
        `Token verification failed: ${msg}`,
        "invalid_token",
      );
    }

    // Validate issuer pattern (tenant ID varies per user)
    const iss = payload.iss;
    if (typeof iss !== "string" || !issuerPattern.test(iss)) {
      logger.warn("invalid issuer", { issuer: String(iss) });
      throw new TokenValidationError(
        `Invalid issuer: ${String(iss)}`,
        "invalid_token",
      );
    }

    // Validate authorized party matches our client ID
    const azp = payload["azp"];
    if (typeof azp !== "string" || azp !== clientId) {
      logger.warn("invalid authorized party", {
        expected: clientId,
        actual: String(azp),
      });
      throw new TokenValidationError(
        `Invalid authorized party: expected ${clientId}, got ${String(azp)}`,
        "invalid_token",
      );
    }

    return {
      sub: payload.sub ?? "",
      iss,
      aud: Array.isArray(payload.aud) ? payload.aud.join(" ") : (payload.aud ?? ""),
      azp,
      scp: typeof payload["scp"] === "string" ? payload["scp"] : undefined,
      exp: payload.exp ?? 0,
      raw: payload,
    };
  };
}

/** Create a validator for the production Azure AD JWKS endpoint. */
export function createAzureADValidator(clientId: string): ValidateTokenFn {
  const jwks = createRemoteJWKSet(JWKS_URL);
  return createTokenValidator(jwks, clientId);
}
