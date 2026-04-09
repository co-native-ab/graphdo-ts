// Lightweight HTTP client for Microsoft Graph API.

import type { GraphErrorEnvelope } from "./types.js";
import { logger } from "../logger.js";

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

/** HTTP client for Microsoft Graph API using native fetch. */
export class GraphClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl = "https://graph.microsoft.com/v1.0",
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
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

    const response = await fetch(url, init);

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
