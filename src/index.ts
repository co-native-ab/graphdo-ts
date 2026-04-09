// graphdo-ts — MCP server for Microsoft Graph (email + todos).
// Entry point: Express server with Streamable HTTP transport.

import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

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

export const CLIENT_ID = "b073490b-a1a2-4bb8-9d83-00bb5c15fcfd";

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

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/** Start the HTTP server with MCP Streamable HTTP transport. */
export async function startServer(): Promise<HttpServer> {
  const app = express();
  app.use(express.json());
  app.use(
    cors({
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  );

  // POST /mcp — main MCP endpoint
  app.post("/mcp", async (req: AuthenticatedRequest, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    const token = extractBearerToken(req);
    if (token) {
      req.auth = { token, clientId: CLIENT_ID, scopes: [...SCOPES] };
    }

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
      if (!token) {
        res
          .set("WWW-Authenticate", `Bearer resource="${GRAPH_BASE_URL}"`)
          .status(401)
          .json({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Unauthorized: Bearer token required",
            },
            id: null,
          });
        return;
      }
      await transport.handleRequest(req, res, req.body as Record<string, unknown>);
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
    await transport.handleRequest(req, res, req.body as Record<string, unknown>);
  });

  // GET /mcp — SSE streams
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

    const token = extractBearerToken(req);
    if (token) {
      req.auth = { token, clientId: CLIENT_ID, scopes: [...SCOPES] };
    } else {
      res
        .set("WWW-Authenticate", `Bearer resource="${GRAPH_BASE_URL}"`)
        .status(401)
        .json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Unauthorized: Bearer token required",
          },
          id: null,
        });
      return;
    }

    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete("/mcp", async (req, res) => {
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

main().catch((err: unknown) => {
  logger.error("fatal", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
