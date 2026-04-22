// Picker flow descriptor — generic browser-based option picker.
//
// Replaces the standalone `src/picker.ts` with a thin flow descriptor
// on top of `runBrowserFlow`.

import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { UserCancelledError } from "../../errors.js";
import { logger } from "../../logger.js";
import { pickerPageHtml } from "../../templates/picker.js";
import type { BrowserFlow, FlowContext, RouteTable } from "../server.js";
import { readJsonWithCsrf, respondAndClose, runBrowserFlow } from "../server.js";

// ---------------------------------------------------------------------------
// Public types (unchanged from the old picker.ts)
// ---------------------------------------------------------------------------

export interface PickerOption {
  id: string;
  label: string;
}

/** Link shown below the options list — typically "Create new ... in <service>". */
export interface PickerCreateLink {
  /** External URL the link opens. */
  url: string;
  /** Short label for the link (e.g. "Create new folder in OneDrive"). */
  label: string;
  /** Optional description shown next to the link so the agent/user knows why it's there. */
  description?: string;
}

export interface PickerConfig {
  title: string;
  subtitle: string;
  /** Initial set of options shown when the page first loads. */
  options: PickerOption[];
  /** Called when the user selects an option. Errors are surfaced to the browser. */
  onSelect: (option: PickerOption, signal: AbortSignal) => Promise<void>;
  /**
   * Optional callback used to re-fetch options when the user clicks the
   * refresh button. When omitted, the refresh button is hidden. The returned
   * list replaces the in-memory set of valid selections on the server so the
   * selection-validation logic stays consistent after a refresh.
   */
  refreshOptions?: (signal: AbortSignal) => Promise<PickerOption[]>;
  /** Optional "Create new ..." link shown below the options list. */
  createLink?: PickerCreateLink;
  /** Placeholder shown in the filter input. Defaults to "Filter...". */
  filterPlaceholder?: string;
  /** Timeout in milliseconds (default: 120 000 - 2 minutes). */
  timeoutMs?: number;
}

export interface PickerResult {
  /** The option the user selected. */
  selected: PickerOption;
}

export interface PickerHandle {
  /** URL where the picker page is served. */
  url: string;
  /** Resolves when the user makes a selection (or rejects on timeout/error). */
  waitForSelection: Promise<PickerResult>;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SelectionSchema = z.object({ id: z.string(), label: z.string(), csrfToken: z.string() });
const CancelSchema = z.object({ csrfToken: z.string() });

// ---------------------------------------------------------------------------
// pickerFlow descriptor
// ---------------------------------------------------------------------------

export function pickerFlow(config: PickerConfig, signal: AbortSignal): BrowserFlow<PickerResult> {
  return {
    name: "picker",
    timeoutMs: config.timeoutMs,
    routes: (ctx: FlowContext<PickerResult>): RouteTable => {
      // Mutable view of the currently-valid options. Refresh replaces this, and
      // /select validates against it, so a selection can never resolve to a
      // stale option that is no longer offered.
      const state = {
        options: [...config.options],
      };

      return {
        "GET /": (_req, res, nonce) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            pickerPageHtml({
              title: config.title,
              subtitle: config.subtitle,
              options: state.options,
              filterPlaceholder: config.filterPlaceholder,
              createLink: config.createLink,
              refreshEnabled: config.refreshOptions !== undefined,
              csrfToken: ctx.csrfToken,
              nonce,
            }),
          );
        },

        "GET /options": (_req: IncomingMessage, res: ServerResponse) => {
          const provider = config.refreshOptions;
          if (provider === undefined) {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Refresh not supported");
            return;
          }
          void (async () => {
            try {
              const fresh = await provider(signal);
              // Replace the set of valid selections the server will accept.
              state.options = [...fresh];
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ options: fresh.map((o) => ({ id: o.id, label: o.label })) }),
              );
              logger.info("picker options refreshed", { count: fresh.length });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              logger.error("picker refresh failed", { error: message });
              // Intentionally do not forward the internal error message to the browser
              // response (stack-trace / internals exposure). The client shows a
              // generic "Refresh failed" message; detailed context is in the logs.
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "refresh failed" }));
            }
          })();
        },

        "POST /select": (req, res) => {
          readJsonWithCsrf(req, res, ctx, SelectionSchema, async (data) => {
            const { id } = data;
            // Validate the selection against the server's current (possibly
            // refreshed) option set so the user can't smuggle in a stale ID.
            const match = state.options.find((opt) => opt.id === id);
            if (!match) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Invalid selection");
              return;
            }

            await config.onSelect(match, signal);

            logger.info("picker selection made", {
              id: match.id,
              label: match.label,
            });

            respondAndClose(res, ctx.server, { ok: true });
            ctx.resolve({ selected: match });
          });
        },

        "POST /cancel": (req, res) => {
          readJsonWithCsrf(req, res, ctx, CancelSchema, () => {
            respondAndClose(res, ctx.server, { ok: true });
            ctx.reject(new UserCancelledError("Selection cancelled by user"));
          });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// runPicker — public wrapper with the same shape as startBrowserPicker
// ---------------------------------------------------------------------------

/**
 * Start a local picker server. Returns the URL immediately and a promise
 * that resolves when the user picks an option.
 */
export async function runPicker(config: PickerConfig, signal: AbortSignal): Promise<PickerHandle> {
  const handle = await runBrowserFlow(pickerFlow(config, signal), signal);
  return {
    url: handle.url,
    waitForSelection: handle.result,
  };
}
