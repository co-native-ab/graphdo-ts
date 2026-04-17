// Generic browser-based picker - local HTTP server serving an HTML selection page.
//
// Serves a page with clickable options. When the user selects one, the callback
// is invoked and the server shuts down. Reusable for any browser-based selection
// (todo list config, account picker, etc.).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

import { z } from "zod";
import { logger } from "./logger.js";
import { UserCancelledError } from "./errors.js";
import { pickerPageHtml } from "./templates/picker.js";

// ---------------------------------------------------------------------------
// Public types
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
// Constants
// ---------------------------------------------------------------------------

/** Maximum POST body size for selection requests (1 MB). */
const MAX_BODY_SIZE = 1_048_576;

// ---------------------------------------------------------------------------
// Picker server
// ---------------------------------------------------------------------------

/**
 * Start a local picker server. Returns the URL immediately and a promise
 * that resolves when the user picks an option.
 */
export function startBrowserPicker(
  config: PickerConfig,
  signal: AbortSignal,
): Promise<PickerHandle> {
  const timeoutMs = config.timeoutMs ?? 120_000;

  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled"),
    );
  }

  return new Promise<PickerHandle>((resolveHandle, rejectHandle) => {
    let onSelected: (result: PickerResult) => void;
    let onError: (err: Error) => void;

    const waitForSelection = new Promise<PickerResult>((resolve, reject) => {
      onSelected = resolve;
      onError = reject;
    });

    // Mutable view of the currently-valid options. Refresh replaces this, and
    // /select validates against it, so a selection can never resolve to a
    // stale option that is no longer offered.
    const state: PickerState = { options: [...config.options], onSelect: config.onSelect };

    const server = createServer((req, res) => {
      handleRequest(req, res, config, state, server, onSelected, onError, signal);
    });

    // Shut down the server when the signal is aborted
    const onAbort = (): void => {
      server.close();
      onError(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        const err = new Error("Failed to get server address");
        rejectHandle(err);
        return;
      }
      const url = `http://127.0.0.1:${String(addr.port)}`;
      logger.info("picker server started", { url });
      resolveHandle({ url, waitForSelection });
    });

    server.on("error", (err) => {
      logger.error("picker server error", { error: err.message });
      rejectHandle(err);
    });

    const timer = setTimeout(() => {
      logger.warn("picker server timed out");
      server.close();
      onError(
        new Error("Selection timed out - no choice made within the time limit. Please try again."),
      );
    }, timeoutMs);

    server.on("close", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

interface PickerState {
  options: PickerOption[];
  onSelect: PickerConfig["onSelect"];
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: PickerConfig,
  state: PickerState,
  server: Server,
  onSelected: (result: PickerResult) => void,
  onError: (err: Error) => void,
  signal: AbortSignal,
): void {
  const url = req.url ?? "/";

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'",
  );

  if (req.method === "GET" && url === "/") {
    servePickerPage(res, config, state);
    return;
  }

  if (req.method === "GET" && url === "/options") {
    handleGetOptions(res, config, state, signal);
    return;
  }

  if (req.method === "POST" && url === "/select") {
    handleSelection(req, res, state, server, onSelected, signal);
    return;
  }

  if (req.method === "POST" && url === "/cancel") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      server.close();
    }, 100);
    onError(new UserCancelledError("Selection cancelled by user"));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function servePickerPage(res: ServerResponse, config: PickerConfig, state: PickerState): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(
    pickerPageHtml({
      title: config.title,
      subtitle: config.subtitle,
      options: state.options,
      filterPlaceholder: config.filterPlaceholder,
      createLink: config.createLink,
      refreshEnabled: config.refreshOptions !== undefined,
    }),
  );
}

function handleGetOptions(
  res: ServerResponse,
  config: PickerConfig,
  state: PickerState,
  signal: AbortSignal,
): void {
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
      res.end(JSON.stringify({ options: fresh.map((o) => ({ id: o.id, label: o.label })) }));
      logger.info("picker options refreshed", { count: fresh.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("picker refresh failed", { error: message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  })();
}

const SelectionSchema = z.object({ id: z.string(), label: z.string() });

function handleSelection(
  req: IncomingMessage,
  res: ServerResponse,
  state: PickerState,
  server: Server,
  onSelected: (result: PickerResult) => void,
  signal: AbortSignal,
): void {
  let body = "";
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Payload Too Large");
      req.destroy();
      return;
    }
    body += chunk.toString();
  });
  req.on("end", () => {
    void (async () => {
      try {
        const parseResult = SelectionSchema.safeParse(JSON.parse(body));
        if (!parseResult.success) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid request body");
          return;
        }
        const { id } = parseResult.data;

        // Validate the selection against the server's current (possibly
        // refreshed) option set so the user can't smuggle in a stale ID.
        const match = state.options.find((opt) => opt.id === id);
        if (!match) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid selection");
          return;
        }

        await state.onSelect(match, signal);

        logger.info("picker selection made", {
          id: match.id,
          label: match.label,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

        // Shut down after a brief delay to let the response flush
        setTimeout(() => {
          server.close();
          onSelected({ selected: match });
        }, 100);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("picker selection failed", { error: message });
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error: ${message}`);
      }
    })();
  });
}
