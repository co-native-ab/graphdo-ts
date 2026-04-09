import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, type TestEnv } from "../helpers.js";
import { GraphClient, GraphRequestError } from "../../src/graph/client.js";

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
