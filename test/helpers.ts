import type { MockState } from "./mock-graph.js";
import { createMockGraphServer, MockState as MockStateClass } from "./mock-graph.js";
import { validateGraphId, type ValidatedGraphId } from "../src/graph/ids.js";

export interface TestEnv {
  state: MockState;
  graphUrl: string;
  cleanup: () => Promise<void>;
}

/**
 * Test-only shorthand that brands a string as a {@link ValidatedGraphId}
 * by running it through {@link validateGraphId}. Lets fixture code keep
 * passing string literals like `"list-1"` while still satisfying the
 * helper signatures introduced by ADR-0007.
 */
export function gid(value: string): ValidatedGraphId {
  return validateGraphId("test-id", value);
}

/**
 * Returns a per-test AbortSignal that times out after 10 seconds.
 * Analogous to a CancellationToken in xUnit's test context — provides a
 * deadline for async operations in tests.
 */
export function testSignal(): AbortSignal {
  return AbortSignal.timeout(10_000);
}

/**
 * Fetch the loopback page at `pageUrl` and extract the CSRF token from the
 * `<meta name="csrf-token">` tag. Throws if the meta tag is missing.
 *
 * Used by tests that POST to `/select` or `/cancel` on the picker / login
 * loopback servers — they require a valid CSRF token + JSON Content-Type
 * after the §5.4 hardening.
 */
export async function fetchCsrfToken(pageUrl: string): Promise<string> {
  const res = await fetch(pageUrl);
  const html = await res.text();
  const match = /<meta name="csrf-token" content="([^"]+)">/.exec(html);
  if (!match?.[1]) {
    throw new Error(`No csrf-token meta tag found at ${pageUrl}`);
  }
  return match[1];
}

export async function createTestEnv(): Promise<TestEnv> {
  const state = new MockStateClass();

  state.user = {
    id: "user-1",
    displayName: "Test User",
    mail: "test@example.com",
    userPrincipalName: "test@example.com",
  };

  state.todoLists = [{ id: "list-1", displayName: "My Tasks" }];

  state.todos.set("list-1", [{ id: "task-1", title: "Buy milk", status: "notStarted" }]);

  const { server, url } = await createMockGraphServer(state);

  const cleanup = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((err?: Error) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

  return { state, graphUrl: url, cleanup };
}
