import { describe, it, expect, vi } from "vitest";

import { wireShutdownSignals } from "../src/index.js";
import type { ShutdownProcess, ShutdownStdin } from "../src/index.js";

type Handler = () => void;
type ErrHandler = (err: Error) => void;

function fakeProcess(): {
  proc: ShutdownProcess;
  fire: (ev: "SIGINT" | "SIGTERM" | "SIGHUP") => void;
} {
  const handlers = new Map<string, Handler>();
  return {
    proc: {
      once(event, listener): unknown {
        handlers.set(event, listener);
        return undefined;
      },
    },
    fire: (ev): void => handlers.get(ev)?.(),
  };
}

function fakeStdin(): {
  stdin: ShutdownStdin;
  fireEnd: () => void;
  fireClose: () => void;
  fireError: (err: Error) => void;
} {
  const onceHandlers = new Map<string, Handler>();
  const errHandlers: ErrHandler[] = [];
  return {
    stdin: {
      once(event, listener): unknown {
        onceHandlers.set(event, listener);
        return undefined;
      },
      on(_event, listener): unknown {
        errHandlers.push(listener);
        return undefined;
      },
    },
    fireEnd: (): void => onceHandlers.get("end")?.(),
    fireClose: (): void => onceHandlers.get("close")?.(),
    fireError: (err): void =>
      errHandlers.forEach((h) => {
        h(err);
      }),
  };
}

describe("wireShutdownSignals", () => {
  it("aborts the controller on SIGINT", () => {
    const ctrl = new AbortController();
    const p = fakeProcess();
    const s = fakeStdin();
    wireShutdownSignals(ctrl, p.proc, s.stdin);
    expect(ctrl.signal.aborted).toBe(false);
    p.fire("SIGINT");
    expect(ctrl.signal.aborted).toBe(true);
    expect((ctrl.signal.reason as Error).message).toBe("SIGINT");
  });

  it("aborts the controller on SIGTERM", () => {
    const ctrl = new AbortController();
    const p = fakeProcess();
    const s = fakeStdin();
    wireShutdownSignals(ctrl, p.proc, s.stdin);
    p.fire("SIGTERM");
    expect((ctrl.signal.reason as Error).message).toBe("SIGTERM");
  });

  it("aborts the controller on SIGHUP (Copilot CLI reload path)", () => {
    const ctrl = new AbortController();
    const p = fakeProcess();
    const s = fakeStdin();
    wireShutdownSignals(ctrl, p.proc, s.stdin);
    p.fire("SIGHUP");
    expect((ctrl.signal.reason as Error).message).toBe("SIGHUP");
  });

  it("aborts the controller when stdin ends (pipe closed by parent)", () => {
    const ctrl = new AbortController();
    const p = fakeProcess();
    const s = fakeStdin();
    wireShutdownSignals(ctrl, p.proc, s.stdin);
    s.fireEnd();
    expect((ctrl.signal.reason as Error).message).toBe("stdin-end");
  });

  it("aborts the controller when stdin closes", () => {
    const ctrl = new AbortController();
    const p = fakeProcess();
    const s = fakeStdin();
    wireShutdownSignals(ctrl, p.proc, s.stdin);
    s.fireClose();
    expect((ctrl.signal.reason as Error).message).toBe("stdin-close");
  });

  it("aborts the controller when stdin errors", () => {
    const ctrl = new AbortController();
    const p = fakeProcess();
    const s = fakeStdin();
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    wireShutdownSignals(ctrl, p.proc, s.stdin);
    s.fireError(new Error("EPIPE"));
    expect((ctrl.signal.reason as Error).message).toBe("stdin-error");
    warn.mockRestore();
  });

  it("is idempotent — repeated triggers after first abort are no-ops", () => {
    const ctrl = new AbortController();
    const p = fakeProcess();
    const s = fakeStdin();
    wireShutdownSignals(ctrl, p.proc, s.stdin);
    p.fire("SIGTERM");
    const firstReason = ctrl.signal.reason as Error;
    s.fireClose();
    p.fire("SIGINT");
    // Reason should still be the first trigger, not overwritten.
    expect(ctrl.signal.reason).toBe(firstReason);
    expect(firstReason.message).toBe("SIGTERM");
  });
});
