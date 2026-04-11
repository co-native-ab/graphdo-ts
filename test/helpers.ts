import type { MockState } from "./mock-graph.js";
import { createMockGraphServer, MockState as MockStateClass } from "./mock-graph.js";

export interface TestEnv {
  state: MockState;
  graphUrl: string;
  cleanup: () => Promise<void>;
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
