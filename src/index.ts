// graphdo-ts — MCP server for Microsoft Graph (email + todos).
// Entry point: HTTP server with Streamable HTTP transport.

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";

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

export const VERSION = "0.1.0";

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
// HTTP helpers
// ---------------------------------------------------------------------------

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice(7);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "WWW-Authenticate": `Bearer resource="${GRAPH_BASE_URL}"`,
    "Content-Type": "application/json",
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: Bearer token required" },
      id: null,
    }),
  );
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

async function handlePost(
  req: AuthenticatedRequest,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Read and parse body
  const raw = await readBody(req);
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
    return;
  }

  // Attach auth info
  const token = extractBearerToken(req);
  if (token) {
    req.auth = { token, clientId: CLIENT_ID, scopes: [...SCOPES] };
  }

  // --- Existing session ---
  if (sessionId) {
    const transport = transports.get(sessionId);
    if (!transport) {
      sendJson(res, 404, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found" },
        id: null,
      });
      return;
    }
    if (!token) {
      sendUnauthorized(res);
      return;
    }
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  // --- New session (initialization) ---
  if (!isInitializeRequest(parsedBody)) {
    sendJson(res, 400, {
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
  await transport.handleRequest(req, res, parsedBody);
}

async function handleGet(
  req: AuthenticatedRequest,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Missing session ID" },
      id: null,
    });
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    sendJson(res, 404, {
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
    sendUnauthorized(res);
    return;
  }

  await transport.handleRequest(req, res);
}

async function handleDelete(
  req: AuthenticatedRequest,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Missing session ID" },
      id: null,
    });
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    sendJson(res, 404, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/** Start the HTTP server with MCP Streamable HTTP transport. */
export async function startServer(): Promise<HttpServer> {
  const httpServer = createServer((req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const handle = async (): Promise<void> => {
      switch (req.method) {
        case "POST":
          await handlePost(req, res);
          break;
        case "GET":
          await handleGet(req, res);
          break;
        case "DELETE":
          await handleDelete(req, res);
          break;
        default:
          res.writeHead(405);
          res.end("Method Not Allowed");
      }
    };

    handle().catch((err: unknown) => {
      logger.error("request error", {
        method: req.method,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
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

  return new Promise((resolve) => {
    httpServer.listen(PORT, () => {
      logger.info("server started", { port: PORT });
      resolve(httpServer);
    });
  });
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
