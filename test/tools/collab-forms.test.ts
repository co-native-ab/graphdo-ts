// Form-factory unit tests — `18-form-busy-lock.test.ts` early-stub variant.
//
// The full integration test ("18-form-busy-lock.test.ts") runs against
// the real init / destructive forms once those land. This file exercises
// the §5.3 lock contract directly against an early stub form so the
// factory's behaviour is locked in independently of the form HTML.
//
// Scenarios covered (matches §8 row 18 sub-tests):
//   1. While a form holds the slot, a second acquire returns FormBusyError
//      carrying the URL of the in-flight form.
//   2. Lock-release matrix — slot released on every terminal outcome:
//        a. submit
//        b. cancel
//        c. timeout
//        d. transport abort (caller's signal aborted)
//        e. uncaught exception inside the form's submit handler
//      After each, a fresh acquireFormSlot call must succeed.

import { afterEach, describe, expect, it } from "vitest";

import { FormBusyError } from "../../src/errors.js";
import {
  acquireFormSlot,
  getActiveFormSlotForTest,
  resetFormFactoryForTest,
} from "../../src/tools/collab-forms.js";

afterEach(() => {
  // Belt-and-braces — tests should release their own slots, but if a
  // test fails mid-flight we don't want it to leak into the next test.
  resetFormFactoryForTest();
});

/**
 * Run a form lifecycle with the given terminal outcome. Mirrors the way
 * a real tool would use the factory: acquire → publish URL → await form
 * promise → release in finally.
 */
async function runStubForm(
  kind: string,
  url: string,
  terminate: (resolve: () => void, reject: (err: Error) => void) => void,
): Promise<void> {
  const slot = acquireFormSlot(kind);
  try {
    slot.setUrl(url);
    await new Promise<void>((resolve, reject) => {
      terminate(resolve, reject);
    });
  } finally {
    slot.release();
  }
}

describe("acquireFormSlot — single-in-flight contract", () => {
  it("blocks a second acquire while the first slot is held, with URL on the error", () => {
    const first = acquireFormSlot("init");
    first.setUrl("http://127.0.0.1:54321");

    expect(() => acquireFormSlot("destructive")).toThrow(FormBusyError);

    let captured: FormBusyError | undefined;
    try {
      acquireFormSlot("destructive");
    } catch (err) {
      if (err instanceof FormBusyError) captured = err;
    }
    expect(captured).toBeInstanceOf(FormBusyError);
    expect(captured?.url).toBe("http://127.0.0.1:54321");
    expect(captured?.kind).toBe("init");
    // Message includes the in-flight URL so the agent can guide the user.
    expect(captured?.message).toContain("http://127.0.0.1:54321");

    first.release();

    // Slot is now free; a fresh acquire must succeed.
    const second = acquireFormSlot("destructive");
    expect(getActiveFormSlotForTest()?.kind).toBe("destructive");
    second.release();
  });

  it("FormBusyError carries an empty URL when the form server is still starting", () => {
    const first = acquireFormSlot("init");
    // Intentionally do not call setUrl — simulates the brief window
    // between acquiring the slot and the loopback server binding.
    let captured: FormBusyError | undefined;
    try {
      acquireFormSlot("destructive");
    } catch (err) {
      if (err instanceof FormBusyError) captured = err;
    }
    expect(captured).toBeInstanceOf(FormBusyError);
    expect(captured?.url).toBe("");
    expect(captured?.message).toContain("still starting");
    first.release();
  });

  it("setUrl after release is a no-op (does not resurrect the slot)", () => {
    const slot = acquireFormSlot("init");
    slot.release();
    slot.setUrl("http://127.0.0.1:11111");
    expect(getActiveFormSlotForTest()).toBeUndefined();
    // Fresh acquire after release succeeds.
    const next = acquireFormSlot("destructive");
    next.release();
  });

  it("release is idempotent", () => {
    const slot = acquireFormSlot("init");
    slot.release();
    slot.release(); // does not throw
    expect(() => acquireFormSlot("destructive")).not.toThrow();
    resetFormFactoryForTest();
  });
});

describe("acquireFormSlot — lock-release matrix (per §5.3)", () => {
  it("releases the slot on submit (form promise resolves)", async () => {
    await runStubForm("init", "http://127.0.0.1:1", (resolve) => {
      // Simulate the user clicking Submit — form promise resolves.
      setImmediate(resolve);
    });
    expect(getActiveFormSlotForTest()).toBeUndefined();
    const next = acquireFormSlot("destructive");
    next.release();
  });

  it("releases the slot on cancel (form promise rejects with UserCancelledError)", async () => {
    await expect(
      runStubForm("init", "http://127.0.0.1:2", (_resolve, reject) => {
        setImmediate(() => reject(new Error("Selection cancelled by user")));
      }),
    ).rejects.toThrow("Selection cancelled by user");
    expect(getActiveFormSlotForTest()).toBeUndefined();
    const next = acquireFormSlot("destructive");
    next.release();
  });

  it("releases the slot on timeout (form promise rejects with timeout error)", async () => {
    await expect(
      runStubForm("init", "http://127.0.0.1:3", (_resolve, reject) => {
        setImmediate(() => reject(new Error("Selection timed out")));
      }),
    ).rejects.toThrow("timed out");
    expect(getActiveFormSlotForTest()).toBeUndefined();
    const next = acquireFormSlot("destructive");
    next.release();
  });

  it("releases the slot on transport abort (caller's signal aborted)", async () => {
    const ctrl = new AbortController();
    const formPromise = (async () => {
      const slot = acquireFormSlot("init");
      try {
        slot.setUrl("http://127.0.0.1:4");
        await new Promise<void>((_resolve, reject) => {
          ctrl.signal.addEventListener(
            "abort",
            () => {
              reject(
                ctrl.signal.reason instanceof Error ? ctrl.signal.reason : new Error("aborted"),
              );
            },
            { once: true },
          );
        });
      } finally {
        slot.release();
      }
    })();
    setImmediate(() => ctrl.abort(new Error("transport aborted")));
    await expect(formPromise).rejects.toThrow("transport aborted");
    expect(getActiveFormSlotForTest()).toBeUndefined();
    const next = acquireFormSlot("destructive");
    next.release();
  });

  it("releases the slot when an uncaught exception is thrown in the form handler", async () => {
    await expect(
      runStubForm("init", "http://127.0.0.1:5", () => {
        // Simulate an unexpected error in the form's submit handler.
        throw new Error("boom in submit handler");
      }),
    ).rejects.toThrow("boom in submit handler");
    expect(getActiveFormSlotForTest()).toBeUndefined();
    // Even after a thrown handler, a fresh form request must succeed —
    // i.e. failure to release would deadlock all subsequent tools.
    const next = acquireFormSlot("destructive");
    next.release();
  });
});

describe("acquireFormSlot — diagnostic helpers", () => {
  it("getActiveFormSlotForTest reflects the current slot's kind and URL", () => {
    expect(getActiveFormSlotForTest()).toBeUndefined();
    const slot = acquireFormSlot("login");
    expect(getActiveFormSlotForTest()).toEqual({ kind: "login", url: "" });
    slot.setUrl("http://127.0.0.1:9999");
    expect(getActiveFormSlotForTest()).toEqual({ kind: "login", url: "http://127.0.0.1:9999" });
    slot.release();
    expect(getActiveFormSlotForTest()).toBeUndefined();
  });

  it("resetFormFactoryForTest clears a leaked slot", () => {
    acquireFormSlot("init");
    expect(getActiveFormSlotForTest()).toBeDefined();
    resetFormFactoryForTest();
    expect(getActiveFormSlotForTest()).toBeUndefined();
  });
});
