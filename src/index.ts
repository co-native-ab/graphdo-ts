// graphdo-ts — MCP server providing AI agents with scoped access to Microsoft Graph.
// Entry point: Express server with Streamable HTTP transport.

import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  AUTHORIZATION_SERVER,
  CLIENT_ID,
  RESOURCE_SCOPES,
  TokenValidationError,
  createAzureADValidator,
} from "./auth.js";
import type { ValidateTokenFn } from "./auth.js";
import { configDir } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { registerMailTools } from "./tools/mail.js";
import { registerTodoTools } from "./tools/todo.js";
import { registerConfigTools } from "./tools/config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

declare const __VERSION__: string;
export const VERSION: string = __VERSION__;

export const GRAPH_BASE_URL =
  process.env["GRAPHDO_GRAPH_URL"] ?? "https://graph.microsoft.com/v1.0";

export const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

// Re-export CLIENT_ID from auth.ts for backward compat
export { CLIENT_ID } from "./auth.js";

export const SCOPES: readonly string[] = [
  "Mail.Send",
  "Tasks.ReadWrite",
  "User.Read",
  "offline_access",
];

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

/** Create a configured McpServer instance. Tools are registered by callers. */
export function createMcpServer(): McpServer {
  return new McpServer(
    { name: "graphdo", version: VERSION },
    { capabilities: { logging: {} } },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuthenticatedRequest extends express.Request {
  auth?: AuthInfo;
}

function extractBearerToken(req: express.Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice(7);
}

/** Build the resource_metadata URL for WWW-Authenticate headers. */
function resourceMetadataUrl(req: express.Request): string {
  const proto = req.protocol;
  const host = req.get("host") ?? `localhost:${PORT}`;
  return `${proto}://${host}/.well-known/oauth-protected-resource`;
}

/** Send a 401 response with proper MCP-spec WWW-Authenticate header. */
function sendUnauthorized(
  req: express.Request,
  res: express.Response,
  message: string,
): void {
  const metadataUrl = resourceMetadataUrl(req);
  const scope = RESOURCE_SCOPES.join(" ");
  res
    .set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`,
    )
    .status(401)
    .json({
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /** Override token validation (for testing with mock OIDC provider). */
  validateToken?: ValidateTokenFn;
}

/** Start the HTTP server with MCP Streamable HTTP transport. */
export async function startServer(
  options?: ServerOptions,
): Promise<HttpServer> {
  const validateToken =
    options?.validateToken ?? createAzureADValidator(CLIENT_ID);

  const app = express();
  app.use(express.json());
  app.use(
    cors({
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  );

  // ---- Protected Resource Metadata (RFC 9728) ----

  const resourceMetadataHandler: express.RequestHandler = (req, res) => {
    const proto = req.protocol;
    const host = req.get("host") ?? `localhost:${PORT}`;
    const resource = `${proto}://${host}`;

    res.json({
      resource,
      authorization_servers: [AUTHORIZATION_SERVER],
      scopes_supported: [...RESOURCE_SCOPES],
      bearer_methods_supported: ["header"],
    });
  };

  app.get(
    "/.well-known/oauth-protected-resource",
    resourceMetadataHandler,
  );
  app.get(
    "/.well-known/oauth-protected-resource/mcp",
    resourceMetadataHandler,
  );

  // ---- Auth middleware for /mcp routes ----

  async function authenticateRequest(
    req: AuthenticatedRequest,
    res: express.Response,
  ): Promise<boolean> {
    const rawToken = extractBearerToken(req);
    if (!rawToken) {
      sendUnauthorized(req, res, "Unauthorized: Bearer token required");
      return false;
    }

    try {
      const claims = await validateToken(rawToken);
      const scopeList = claims.scp?.split(" ") ?? [];
      req.auth = { token: rawToken, clientId: claims.azp, scopes: scopeList };
      return true;
    } catch (err) {
      if (err instanceof TokenValidationError) {
        sendUnauthorized(req, res, `Unauthorized: ${err.message}`);
      } else {
        sendUnauthorized(
          req,
          res,
          "Unauthorized: token validation failed",
        );
      }
      return false;
    }
  }

  // ---- POST /mcp — main MCP endpoint ----

  app.post("/mcp", async (req: AuthenticatedRequest, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // --- Existing session ---
    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found" },
          id: null,
        });
        return;
      }
      if (!(await authenticateRequest(req, res))) return;
      await transport.handleRequest(
        req,
        res,
        req.body as Record<string, unknown>,
      );
      return;
    }

    // --- New session (initialization) ---
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: expected initialization request",
        },
        id: null,
      });
      return;
    }

    // Allow initialization without a token — the client may need the 401
    // response to discover the authorization server. If a token IS present,
    // validate it. This mirrors the MCP auth flow: client connects →
    // server responds with capabilities → client authenticates if needed.
    const rawToken = extractBearerToken(req);
    if (rawToken) {
      if (!(await authenticateRequest(req, res))) return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        logger.info("session initialized", { sessionId: sid });
        transports.set(sid, transport);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        logger.info("session closed", { sessionId: sid });
        transports.delete(sid);
      }
    };

    const server = createMcpServer();
    registerMailTools(server);
    registerTodoTools(server);
    registerConfigTools(server);
    await server.connect(transport);
    await transport.handleRequest(
      req,
      res,
      req.body as Record<string, unknown>,
    );
  });

  // ---- GET /mcp — SSE streams ----

  app.get("/mcp", async (req: AuthenticatedRequest, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing session ID" },
        id: null,
      });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found" },
        id: null,
      });
      return;
    }

    if (!(await authenticateRequest(req, res))) return;

    await transport.handleRequest(req, res);
  });

  // ---- DELETE /mcp — session termination ----

  app.delete("/mcp", async (req: AuthenticatedRequest, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing session ID" },
        id: null,
      });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found" },
        id: null,
      });
      return;
    }

    if (!(await authenticateRequest(req, res))) return;

    await transport.handleRequest(req, res);
  });

  const httpServer = await new Promise<HttpServer>((resolve) => {
    const server = app.listen(PORT, () => {
      logger.info("server started", { port: PORT });
      resolve(server);
    });
  });

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("shutting down");
    const closing: Promise<void>[] = [];
    for (const [sid, transport] of transports) {
      logger.debug("closing session", { sessionId: sid });
      closing.push(transport.close());
    }
    void Promise.allSettled(closing).then(() => {
      transports.clear();
      httpServer.close();
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return httpServer;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env["GRAPHDO_DEBUG"] === "true") {
    setLogLevel("debug");
  }

  const cfgDir = configDir(process.env["GRAPHDO_CONFIG_DIR"]);
  logger.debug("config directory", { path: cfgDir });

  await startServer();
}

// Auto-start only when running as the entry point (not when imported by tests).
if (!process.env["VITEST"]) {
  main().catch((err: unknown) => {
    logger.error("fatal", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
