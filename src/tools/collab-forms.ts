// Form-factory for browser-based approval forms.
//
// Implements the §5.3 single-in-flight form contract from
// `docs/plans/collab-v1.md`. Every browser-based approval flow (login,
// the todo-list picker, and the upcoming collab init / open / destructive
// re-prompt / external-source re-prompt forms) acquires a slot on this
// module-level lock before opening its loopback server.
//
// While a slot is held, any other tool that asks for a slot receives a
// `FormBusyError` carrying the URL of the in-flight form so the agent
// can guide the human back to the correct page rather than open a
// confusing second tab.
//
// Lock-release contract: the slot MUST be released on **every** terminal
// outcome — submit, cancel, timeout, transport abort, parent-signal
// abort (SIGINT/SIGTERM into `main()`'s controller), and any uncaught
// exception inside the form's handler chain. Callers therefore wrap
// their entire form-completion flow in `try { ... } finally { slot.release() }`.
// Failure to release would deadlock every subsequent collab tool.
//
// Hardening: this module is the single point that bakes the §5.4
// loopback hardening into every form. The hardening itself lives in
// `src/picker.ts`, `src/loopback.ts`, and `src/loopback-security.ts`;
// the factory's role is to ensure tools cannot bypass it by spinning
// up an ad-hoc loopback server outside the lock.

import { FormBusyError } from "../errors.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Mutable state for the currently-active form, or `null` when no form is
 * open. Module-level (i.e. process-wide) is correct here: the lock is a
 * UX guarantee for the human in front of the browser, and there is only
 * ever one human per server instance.
 */
interface ActiveSlot {
  kind: string;
  url: string;
  /** Released when this slot is freed; lets callers await another slot. */
  released: Promise<void>;
  resolveReleased: () => void;
}

/**
 * Construct a fresh ActiveSlot together with its `released` promise. Kept
 * in a small helper so the resolver is captured without the
 * definite-assignment-assertion (`!`) anti-pattern.
 */
function createActiveSlot(kind: string): ActiveSlot {
  let resolveReleased: () => void = () => {
    /* replaced synchronously by the Promise executor below */
  };
  const released = new Promise<void>((resolve) => {
    resolveReleased = resolve;
  });
  return { kind, url: "", released, resolveReleased };
}

let activeSlot: ActiveSlot | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle returned by {@link acquireFormSlot}. Each handle MUST be passed
 * through `try { ... } finally { handle.release() }` so the slot is
 * released on every terminal outcome.
 */
export interface FormSlot {
  /**
   * The form kind this slot was acquired for (echoed back for logging).
   */
  readonly kind: string;
  /**
   * Set the URL of the form once the loopback server has started
   * listening. Subsequent {@link acquireFormSlot} callers will see this
   * URL on the {@link FormBusyError} they receive.
   *
   * It is safe (no-op) to call after `release()`; it is also safe to
   * never call at all (the URL stays empty for the lifetime of the slot).
   */
  setUrl(url: string): void;
  /**
   * Release the slot. Idempotent; safe to call multiple times. After the
   * first call subsequent calls are no-ops.
   */
  release(): void;
}

/**
 * Try to acquire the form-factory slot for a new browser-based approval
 * form. Throws {@link FormBusyError} carrying the URL (when known) of
 * the in-flight form if another form is already open.
 *
 * The caller is responsible for releasing the slot via
 * `handle.release()` in a `finally` block — see module-level lock-release
 * contract above.
 */
export function acquireFormSlot(kind: string): FormSlot {
  if (activeSlot !== null) {
    throw new FormBusyError(activeSlot.url, activeSlot.kind);
  }

  const slot = createActiveSlot(kind);
  activeSlot = slot;
  logger.debug("form slot acquired", { kind });

  return {
    kind,
    setUrl(url: string): void {
      // Only update the URL if this slot is still active; if the slot
      // has already been released we silently ignore the late update.
      if (activeSlot === slot) {
        slot.url = url;
      }
    },
    release(): void {
      if (activeSlot !== slot) {
        return; // already released or superseded
      }
      activeSlot = null;
      logger.debug("form slot released", { kind });
      slot.resolveReleased();
    },
  };
}

/**
 * Test-only / diagnostic accessor for the currently-active slot. Returns
 * `undefined` when no form is open. Production code MUST NOT branch on
 * this; the only way to safely contend for the lock is via
 * {@link acquireFormSlot}.
 */
export function getActiveFormSlotForTest(): { kind: string; url: string } | undefined {
  if (activeSlot === null) return undefined;
  return { kind: activeSlot.kind, url: activeSlot.url };
}

/**
 * Test-only escape hatch to forcibly clear the slot between tests. Never
 * call from production code paths.
 */
export function resetFormFactoryForTest(): void {
  if (activeSlot !== null) {
    activeSlot.resolveReleased();
    activeSlot = null;
  }
}
