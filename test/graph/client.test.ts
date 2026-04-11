import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, type TestEnv } from "../helpers.js";
import { GraphClient, GraphRequestError, GraphResponseParseError, parseResponse } from "../../src/graph/client.js";
import { UserSchema, TodoItemSchema, GraphListResponseSchema } from "../../src/graph/types.js";

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
    // POST with a body to verify content-type is sent
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
    await expect(
      client.request("GET", "/me/todo/lists/nonexistent/tasks"),
    ).rejects.toThrow(GraphRequestError);
  });

  it("throws GraphRequestError on 401 when token is missing", async () => {
    const badClient = new GraphClient(env.graphUrl, "");
    await expect(badClient.request("GET", "/me")).rejects.toThrow(
      GraphRequestError,
    );
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
    // Create a minimal HTTP server that returns non-JSON error body
    const http = await import("node:http");
    const badServer = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("something went wrong");
    });

    const url = await new Promise<string>((resolve, reject) => {
      badServer.once("error", reject);
      badServer.listen(0, "127.0.0.1", () => {
        const addr = badServer.address();
        if (addr === null || typeof addr === "string") {
          reject(new Error("unexpected address"));
          return;
        }
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    try {
      const badClient = new GraphClient(url, "tok");
      await expect(badClient.request("GET", "/anything")).rejects.toSatisfy(
        (err: unknown) => {
          const gre = err as GraphRequestError;
          return (
            gre instanceof GraphRequestError &&
            gre.code === "UnknownError" &&
            gre.graphMessage === "something went wrong" &&
            gre.statusCode === 500
          );
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        badServer.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});

describe("parseResponse", () => {
  function makeResponse(body: string, status = 200): Response {
    return new Response(body, { status });
  }

  it("parses a valid User response", async () => {
    const body = JSON.stringify({ id: "1", displayName: "Test", mail: "t@e.com", userPrincipalName: "t@e.com" });
    const user = await parseResponse(makeResponse(body), UserSchema, "GET", "/me");
    expect(user.id).toBe("1");
    expect(user.displayName).toBe("Test");
  });

  it("allows extra fields (loose schema)", async () => {
    const body = JSON.stringify({ id: "1", displayName: "Test", mail: "t@e.com", userPrincipalName: "t@e.com", extraField: true });
    const user = await parseResponse(makeResponse(body), UserSchema, "GET", "/me");
    expect(user.id).toBe("1");
  });

  it("throws GraphResponseParseError for missing required fields", async () => {
    const body = JSON.stringify({ id: "1" }); // missing displayName, mail, userPrincipalName
    await expect(
      parseResponse(makeResponse(body), UserSchema, "GET", "/me"),
    ).rejects.toThrow(GraphResponseParseError);
  });

  it("throws GraphResponseParseError for wrong types", async () => {
    const body = JSON.stringify({ id: 123, displayName: "Test", mail: "t@e.com", userPrincipalName: "t@e.com" });
    await expect(
      parseResponse(makeResponse(body), UserSchema, "GET", "/me"),
    ).rejects.toThrow(GraphResponseParseError);
  });

  it("throws GraphResponseParseError for non-JSON body", async () => {
    await expect(
      parseResponse(makeResponse("not json"), UserSchema, "GET", "/me"),
    ).rejects.toThrow(GraphResponseParseError);
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
