import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createTestEnv, type TestEnv } from "../helpers.js";
import {
  GraphClient,
  GraphRequestError,
  GraphResponseParseError,
  parseResponse,
} from "../../src/graph/client.js";
import { UserSchema, TodoItemSchema, GraphListResponseSchema } from "../../src/graph/types.js";

/** Start a local HTTP server with sequential request handlers. */
async function makeServer(
  handlers: ((req: http.IncomingMessage, res: http.ServerResponse) => void)[],
) {
  let call = 0;
  const server = http.createServer((req, res) => {
    const handler = handlers[call] ?? handlers[handlers.length - 1];
    call++;
    handler!(req, res);
  });
  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("unexpected address"));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { server, url };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

const noDelay = (): Promise<void> => Promise.resolve();

describe("GraphClient", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("sends Authorization Bearer header", async () => {
    const response = await client.request("GET", "/me");
    expect(response.status).toBe(200);
  });

  it("sends Content-Type: application/json", async () => {
    const response = await client.request("POST", "/me/sendMail", {
      message: {
        subject: "test",
        body: { contentType: "Text", content: "hi" },
        toRecipients: [{ emailAddress: { address: "a@b.com" } }],
      },
    });
    expect(response.status).toBe(202);
  });

  it("throws GraphRequestError on 4xx responses", async () => {
    await expect(client.request("GET", "/me/todo/lists/nonexistent/tasks")).rejects.toThrow(
      GraphRequestError,
    );
  });

  it("throws GraphRequestError on 401 when token is missing", async () => {
    const badClient = new GraphClient(env.graphUrl, "");
    await expect(badClient.request("GET", "/me")).rejects.toThrow(GraphRequestError);
  });

  it("GraphRequestError has correct code, message, and statusCode", async () => {
    try {
      await client.request("GET", "/me/todo/lists/bad-list/tasks/bad-task");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphRequestError);
      const gre = err as GraphRequestError;
      expect(gre.statusCode).toBe(404);
      expect(gre.code).toBe("NotFound");
      expect(gre.graphMessage).toContain("not found");
      expect(gre.method).toBe("GET");
      expect(gre.path).toBe("/me/todo/lists/bad-list/tasks/bad-task");
    }
  });

  it("handles unparseable error bodies gracefully (UnknownError)", async () => {
    const { server, url } = await makeServer([
      (_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("something went wrong");
      },
    ]);
    try {
      const badClient = new GraphClient(url, "tok");
      await expect(badClient.request("GET", "/anything")).rejects.toSatisfy((err: unknown) => {
        const gre = err as GraphRequestError;
        return (
          gre instanceof GraphRequestError &&
          gre.code === "UnknownError" &&
          gre.graphMessage === "something went wrong" &&
          gre.statusCode === 500
        );
      });
    } finally {
      await closeServer(server);
    }
  });
});

describe("GraphClient timeouts", () => {
  it("throws GraphRequestError on request timeout", async () => {
    const { server, url } = await makeServer([
      () => {
        // Intentionally hang - never respond
      },
    ]);
    try {
      const timeoutClient = new GraphClient(url, "tok", 100);
      await expect(timeoutClient.request("GET", "/hang")).rejects.toSatisfy((err: unknown) => {
        const gre = err as GraphRequestError;
        return (
          gre instanceof GraphRequestError &&
          gre.code === "TimeoutError" &&
          gre.graphMessage.includes("timed out")
        );
      });
    } finally {
      await closeServer(server);
    }
  });
});

describe("GraphClient retry logic", () => {
  it("retries on 429 then succeeds", async () => {
    const { server, url } = await makeServer([
      (_req, res) => {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "TooManyRequests", message: "slow down" } }));
      },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      },
    ]);
    try {
      const client = new GraphClient(url, "tok", 30000, 3, noDelay);
      const resp = await client.request("GET", "/foo");
      expect(resp.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("parses Retry-After header (seconds)", async () => {
    let capturedDelayMs = -1;
    const capturingDelay = (ms: number): Promise<void> => {
      capturedDelayMs = ms;
      return Promise.resolve();
    };
    const { server, url } = await makeServer([
      (_req, res) => {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        res.end(JSON.stringify({ error: { code: "TooManyRequests", message: "wait" } }));
      },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      },
    ]);
    try {
      const client = new GraphClient(url, "tok", 30000, 3, capturingDelay);
      await client.request("GET", "/foo");
      expect(capturedDelayMs).toBe(1000);
    } finally {
      await closeServer(server);
    }
  });

  it("does not retry on 400/404", async () => {
    let callCount = 0;
    const { server, url } = await makeServer([
      (_req, res) => {
        callCount++;
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NotFound", message: "nope" } }));
      },
    ]);
    try {
      const client = new GraphClient(url, "tok", 30000, 3, noDelay);
      await expect(client.request("GET", "/foo")).rejects.toThrow(GraphRequestError);
      expect(callCount).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  it("throws after max retries are exhausted", async () => {
    let callCount = 0;
    const { server, url } = await makeServer([
      (_req, res) => {
        callCount++;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "ServiceUnavailable", message: "try again" } }));
      },
    ]);
    try {
      const client = new GraphClient(url, "tok", 30000, 2, noDelay);
      await expect(client.request("GET", "/foo")).rejects.toThrow(GraphRequestError);
      expect(callCount).toBe(3); // 1 initial + 2 retries
    } finally {
      await closeServer(server);
    }
  });
});

describe("parseResponse", () => {
  function makeResponse(body: string, status = 200): Response {
    return new Response(body, { status });
  }

  it("parses a valid User response", async () => {
    const body = JSON.stringify({
      id: "1",
      displayName: "Test",
      mail: "t@e.com",
      userPrincipalName: "t@e.com",
    });
    const user = await parseResponse(makeResponse(body), UserSchema, "GET", "/me");
    expect(user.id).toBe("1");
    expect(user.displayName).toBe("Test");
  });

  it("allows extra fields (loose schema)", async () => {
    const body = JSON.stringify({
      id: "1",
      displayName: "Test",
      mail: "t@e.com",
      userPrincipalName: "t@e.com",
      extraField: true,
    });
    const user = await parseResponse(makeResponse(body), UserSchema, "GET", "/me");
    expect(user.id).toBe("1");
  });

  it("throws GraphResponseParseError for missing required fields", async () => {
    const body = JSON.stringify({ id: "1" });
    await expect(parseResponse(makeResponse(body), UserSchema, "GET", "/me")).rejects.toThrow(
      GraphResponseParseError,
    );
  });

  it("throws GraphResponseParseError for wrong types", async () => {
    const body = JSON.stringify({
      id: 123,
      displayName: "Test",
      mail: "t@e.com",
      userPrincipalName: "t@e.com",
    });
    await expect(parseResponse(makeResponse(body), UserSchema, "GET", "/me")).rejects.toThrow(
      GraphResponseParseError,
    );
  });

  it("throws GraphResponseParseError for non-JSON body", async () => {
    await expect(parseResponse(makeResponse("not json"), UserSchema, "GET", "/me")).rejects.toThrow(
      GraphResponseParseError,
    );
  });

  it("error includes method, path, and raw body", async () => {
    const body = "invalid json";
    try {
      await parseResponse(makeResponse(body), UserSchema, "GET", "/me");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphResponseParseError);
      const gpe = err as GraphResponseParseError;
      expect(gpe.method).toBe("GET");
      expect(gpe.path).toBe("/me");
      expect(gpe.rawBody).toBe("invalid json");
    }
  });

  it("validates TodoItem schema", async () => {
    const body = JSON.stringify({ id: "t1", title: "Task", status: "notStarted" });
    const item = await parseResponse(makeResponse(body), TodoItemSchema, "GET", "/tasks/t1");
    expect(item.title).toBe("Task");
  });

  it("validates GraphListResponse schema", async () => {
    const schema = GraphListResponseSchema(TodoItemSchema);
    const body = JSON.stringify({ value: [{ id: "t1", title: "Task", status: "notStarted" }] });
    const list = await parseResponse(makeResponse(body), schema, "GET", "/tasks");
    expect(list.value).toHaveLength(1);
    expect(list.value[0]?.title).toBe("Task");
  });
});
