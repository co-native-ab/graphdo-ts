// Logout flow descriptor — browser-based sign-out confirmation.
//
// Extracted from the inline `showLogoutPage` in `src/auth.ts`. The flow
// shows a confirmation page with "Sign Out" and "Cancel" buttons.

import { z } from "zod";

import { UserCancelledError } from "../../errors.js";
import { logger } from "../../logger.js";
import { logoutPageHtml } from "../../templates/logout.js";
import type { BrowserFlow, FlowContext, RouteTable } from "../server.js";
import { readJsonWithCsrf, respondAndClose, runBrowserFlow, serveHtml } from "../server.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ConfirmSchema = z.object({ csrfToken: z.string() });
const CancelSchema = z.object({ csrfToken: z.string() });

// ---------------------------------------------------------------------------
// logoutFlow descriptor
// ---------------------------------------------------------------------------

export function logoutFlow(
  onConfirm: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): BrowserFlow<void> {
  return {
    name: "logout",
    routes: (ctx: FlowContext<void>): RouteTable => ({
      "GET /": (_req, res, nonce) => {
        serveHtml(res, logoutPageHtml({ csrfToken: ctx.csrfToken, nonce }));
      },

      "POST /confirm": (req, res) => {
        readJsonWithCsrf(req, res, ctx, ConfirmSchema, async () => {
          try {
            await onConfirm(signal);
            respondAndClose(res, ctx.server, { ok: true });
            ctx.resolve();
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error("logout confirm failed", { error: message });
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Failed to sign out. Please try again.");
            ctx.server.close();
            ctx.reject(err instanceof Error ? err : new Error(message));
          }
        });
      },

      "POST /cancel": (req, res) => {
        readJsonWithCsrf(req, res, ctx, CancelSchema, () => {
          respondAndClose(res, ctx.server, { ok: true });
          ctx.reject(new UserCancelledError("Logout cancelled by user"));
        });
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// showLogoutConfirmation — public wrapper
// ---------------------------------------------------------------------------

/**
 * Show an interactive logout confirmation page in the browser.
 * Resolves on confirm, rejects with UserCancelledError on cancel,
 * rejects with Error if browser cannot be opened or timeout.
 */
export async function showLogoutConfirmation(
  openBrowser: (url: string) => Promise<void>,
  onConfirm: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const handle = await runBrowserFlow(logoutFlow(onConfirm, signal), signal);
  try {
    await openBrowser(handle.url);
  } catch (err: unknown) {
    handle.close();
    throw err instanceof Error ? err : new Error(String(err));
  }
  await handle.result;
}
