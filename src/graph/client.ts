// Lightweight HTTP client for Microsoft Graph API.

import type { GraphErrorEnvelope } from "./types.js";
import { logger } from "../logger.js";
import { ZodType, ZodError } from "zod";

/**
 * Analogous to Azure.Identity's TokenCredential (Go: azidentity, .NET: Azure.Core).
 * Implemented by Authenticator — handles caching, silent refresh, and throws
 * AuthenticationRequiredError when interaction is needed.
 */
export interface TokenCredential {
  /** Acquire a (possibly cached / silently-refreshed) access token. */
  getToken(): Promise<string>;
}

/** Error thrown when a Graph API request fails. */
export class GraphRequestError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly graphMessage: string,
  ) {
    super(
      `graph ${method} ${path}: ${code}: ${graphMessage} (HTTP ${statusCode})`,
    );
    this.name = "GraphRequestError";
  }
}

/** Error thrown when a Graph API response cannot be parsed/validated. */
export class GraphResponseParseError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly statusCode: number,
    public readonly zodError: ZodError,
    public readonly rawBody: string,
  ) {
    super(
      `Failed to parse Graph API response for ${method} ${path} (HTTP ${statusCode}): ${zodError.message}\nRaw body: ${rawBody}`,
    );
    this.name = "GraphResponseParseError";
  }
}

/**
 * Parse and validate a Graph API response using a Zod schema.
 * Throws GraphResponseParseError on validation failure.
 */
export async function parseResponse<T>(
  response: Response,
  schema: ZodType<T>,
  method?: string,
  path?: string,
): Promise<T> {
  const rawBody = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new GraphResponseParseError(
      method ?? response.url,
      path ?? "",
      response.status,
      new ZodError([
        {
          code: "custom",
          message: "Response body is not valid JSON",
          path: [],
        },
      ]),
      rawBody,
    );
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new GraphResponseParseError(
      method ?? response.url,
      path ?? "",
      response.status,
      result.error,
      rawBody,
    );
  }
  return result.data;
}

/** HTTP client for Microsoft Graph API using native fetch. */
export class GraphClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly credential: TokenCredential;
  private readonly maxRetries: number;
  private readonly _delayFn: (ms: number) => Promise<void>;
  private static readonly retryableStatusCodes = new Set([429, 503, 504]);

  /**
   * @param baseUrl  Graph API base URL (default: https://graph.microsoft.com/v1.0)
   * @param credential  A TokenCredential whose getToken() is called on every request,
   *   or a plain string token (wrapped internally for backward compatibility).
   */
  constructor(
    baseUrl = "https://graph.microsoft.com/v1.0",
    credential: TokenCredential | string,
    timeoutMs = 30000,
    maxRetries = 3,
    delayFn?: (ms: number) => Promise<void>,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.credential =
      typeof credential === "string"
        ? { getToken: () => Promise.resolve(credential) }
        : credential;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this._delayFn = delayFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Send an HTTP request to the Graph API and return the raw Response. */
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    // Acquire a fresh (or silently-refreshed) token for this request.
    // Throws AuthenticationRequiredError if the user needs to re-authenticate.
    const token = await this.credential.getToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    logger.debug("graph request", { method, url });

    const baseInit: RequestInit = { method, headers };
    if (body !== undefined) {
      baseInit.body = JSON.stringify(body);
    }

    let lastError: GraphRequestError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Create a fresh AbortSignal per attempt so each retry gets the full timeout.
      const init: RequestInit = {
        ...baseInit,
        signal: AbortSignal.timeout(this.timeoutMs),
      };

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new GraphRequestError(
            method,
            path,
            0,
            "TimeoutError",
            `Graph API request timed out after ${this.timeoutMs}ms`,
          );
        }
        throw err;
      }

      logger.debug("graph response", { method, url, status: response.status });

      if (response.status < 400) {
        return response;
      }

      // Parse error body for code/message
      const rawBody = await response.text();
      let code = "UnknownError";
      let message = rawBody;

      try {
        const envelope = JSON.parse(rawBody) as unknown;
        if (isGraphErrorEnvelope(envelope)) {
          code = envelope.error.code;
          message = envelope.error.message;
        }
      } catch {
        // Use raw body text as message
      }

      const error = new GraphRequestError(
        method,
        path,
        response.status,
        code,
        message,
      );

      if (
        attempt < this.maxRetries &&
        GraphClient.retryableStatusCodes.has(response.status)
      ) {
        // Determine delay
        let delayMs = 0;
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) {
          const retryAfterSeconds = parseInt(retryAfter, 10);
          if (!isNaN(retryAfterSeconds)) {
            delayMs = retryAfterSeconds * 1000;
          } else {
            // Try HTTP-date format (not common, but spec allows)
            const retryDate = Date.parse(retryAfter);
            if (!isNaN(retryDate)) {
              delayMs = Math.max(0, retryDate - Date.now());
            }
          }
        }
        if (delayMs === 0) {
          delayMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        }
        logger.info("graph retry", {
          method,
          path,
          status: response.status,
          attempt: attempt + 1,
          delayMs,
          code,
          message,
        });
        await this._delayFn(delayMs);
        lastError = error;
        continue;
      }
      // Not retryable or out of retries
      throw error;
    }
    // Should not reach here, but throw last error if so
    throw lastError ?? new GraphRequestError(method, path, 0, "UnknownError", "Unknown error after retries");
  }
}


function isGraphErrorEnvelope(value: unknown): value is GraphErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["error"] !== "object" || obj["error"] === null) return false;
  const err = obj["error"] as Record<string, unknown>;
  return typeof err["code"] === "string" && typeof err["message"] === "string";
}
