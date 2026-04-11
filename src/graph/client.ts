// Lightweight HTTP client for Microsoft Graph API.

import type { GraphErrorEnvelope } from "./types.js";
import { logger } from "../logger.js";
import { ZodType, ZodError } from "zod";

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
  private readonly token: string;

  constructor(
    baseUrl = "https://graph.microsoft.com/v1.0",
    token: string,
    timeoutMs = 30000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /** Send an HTTP request to the Graph API and return the raw Response. */
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    logger.debug("graph request", { method, url });

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    // Add timeout using AbortSignal.timeout (Node.js 18+)
    init.signal = AbortSignal.timeout(this.timeoutMs);

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

    if (response.status >= 400) {
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

      throw new GraphRequestError(
        method,
        path,
        response.status,
        code,
        message,
      );
    }

    return response;
  }
}

function isGraphErrorEnvelope(value: unknown): value is GraphErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["error"] !== "object" || obj["error"] === null) return false;
  const err = obj["error"] as Record<string, unknown>;
  return typeof err["code"] === "string" && typeof err["message"] === "string";
}
