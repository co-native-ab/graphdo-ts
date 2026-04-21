// Generic browser-based picker - local HTTP server serving an HTML selection page.
//
// Serves a page with clickable options. When the user selects one, the callback
// is invoked and the server shuts down. Reusable for any browser-based selection
// (todo list config, account picker, etc.).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

import { z } from "zod";
import { logger } from "./logger.js";
import {
  UserCancelledError,
  InvalidShareUrlError,
  ShareNotFoundError,
  ShareAccessDeniedError,
} from "./errors.js";
import { pickerPageHtml } from "./templates/picker.js";
import {
  buildLoopbackCsp,
  generateRandomToken,
  validateLoopbackPostHeaders,
  verifyCsrfToken,
} from "./loopback-security.js";

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

/**
 * User pasted a OneDrive share URL. Returns either `jump` (replace the
 * picker's option list and breadcrumb without resolving the picker) or
 * `select` (resolve `waitForSelection` immediately with the chosen
 * id+label and shut the server down).
 *
 * Available either as a top-level {@link PickerConfig.onShareUrl} (for
 * non-navigable pickers like `session_open_project`) or as
 * {@link PickerNavigation.onShareUrl} (for navigable pickers like
 * `session_init_project`). When both are supplied the top-level
 * handler wins.
 */
export type ShareUrlHandler = (
  url: string,
  signal: AbortSignal,
) => Promise<
  | { kind: "jump"; options: PickerOption[]; breadcrumb: string[] }
  | { kind: "select"; selected: { id: string; label: string } }
>;

export interface PickerNavigation {
  /** Drill into a folder option. Returns new options and breadcrumb path. */
  onNavigate: (
    option: PickerOption,
    signal: AbortSignal,
  ) => Promise<{ options: PickerOption[]; breadcrumb: string[] }>;

  /** User clicked "Select this folder". Returns the selected folder identity. */
  onSelectCurrent: (signal: AbortSignal) => Promise<{ id: string; label: string }>;

  /** Optional: user pasted a OneDrive share URL. Returns jump-to or direct select. */
  onShareUrl?: ShareUrlHandler;

  /** Initial breadcrumb shown when the picker first loads (e.g. ["My OneDrive"]). */
  initialBreadcrumb: string[];
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
  /** When set, enables navigable folder picker mode (subfolder drill-in + share URL paste). */
  navigation?: PickerNavigation;
  /**
   * Optional: enable the share-URL paste box on a non-navigable picker.
   * The same callback shape as {@link PickerNavigation.onShareUrl}; when
   * the user pastes a URL the handler decides whether to `jump` the
   * option list or `select` directly. When `navigation` is also set,
   * this top-level handler takes precedence over
   * `navigation.onShareUrl`.
   */
  onShareUrl?: ShareUrlHandler;
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
    const state: PickerState = {
      options: [...config.options],
      onSelect: config.onSelect,
      csrfToken: generateRandomToken(),
      hostHeader: "",
      breadcrumb: config.navigation?.initialBreadcrumb ?? [],
    };

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
      state.hostHeader = `127.0.0.1:${String(addr.port)}`;
      const url = `http://${state.hostHeader}`;
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
  /** Per-server CSRF token. Required on every state-changing POST. */
  csrfToken: string;
  /** `127.0.0.1:<port>` — the only Host header value the server will accept. */
  hostHeader: string;
  /** Current breadcrumb path in navigation mode. */
  breadcrumb: string[];
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

  // Per-request CSP nonce. The hardened CSP forbids unsafe-inline, so the
  // inline <style> and <script> in the rendered page must carry this nonce.
  const nonce = generateRandomToken();

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Content-Security-Policy", buildLoopbackCsp(nonce));

  if (req.method === "GET" && url === "/") {
    servePickerPage(res, config, state, nonce);
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
    handleCancel(req, res, state, server, onError);
    return;
  }

  // /share-url is registered when either a top-level `onShareUrl` is
  // set (non-navigable picker, e.g. session_open_project) or
  // `navigation` is configured (in which case `handleShareUrl` falls
  // back to 405 if `navigation.onShareUrl` itself is undefined).
  if (
    req.method === "POST" &&
    url === "/share-url" &&
    (config.onShareUrl !== undefined || config.navigation !== undefined)
  ) {
    handleShareUrl(req, res, config, state, server, onSelected, signal);
    return;
  }

  if (config.navigation !== undefined) {
    if (req.method === "GET" && url === "/breadcrumb") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ breadcrumb: state.breadcrumb }));
      return;
    }
    if (req.method === "POST" && url === "/navigate") {
      handleNavigate(req, res, config, state, signal);
      return;
    }
    if (req.method === "POST" && url === "/select-current") {
      handleSelectCurrent(req, res, config, state, server, onSelected, signal);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function servePickerPage(
  res: ServerResponse,
  config: PickerConfig,
  state: PickerState,
  nonce: string,
): void {
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
      csrfToken: state.csrfToken,
      nonce,
      navigation:
        config.navigation !== undefined
          ? {
              initialBreadcrumb: state.breadcrumb,
              shareUrlEnabled: config.navigation.onShareUrl !== undefined,
            }
          : undefined,
      shareUrlEnabled: config.onShareUrl !== undefined,
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
      // Intentionally do not forward the internal error message to the browser
      // response (stack-trace / internals exposure). The client shows a
      // generic "Refresh failed" message; detailed context is in the logs.
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "refresh failed" }));
    }
  })();
}

const SelectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  csrfToken: z.string(),
});

const CancelSchema = z.object({ csrfToken: z.string() });

const NavigateSchema = z.object({ id: z.string(), csrfToken: z.string() });
const SelectCurrentSchema = z.object({ csrfToken: z.string() });
const ShareUrlSchema = z.object({ url: z.string(), csrfToken: z.string() });

function handleSelection(
  req: IncomingMessage,
  res: ServerResponse,
  state: PickerState,
  server: Server,
  onSelected: (result: PickerResult) => void,
  signal: AbortSignal,
): void {
  const headerCheck = validateLoopbackPostHeaders(req, { allowedHosts: [state.hostHeader] });
  if (!headerCheck.ok) {
    res.writeHead(headerCheck.status, { "Content-Type": "text/plain" });
    res.end(headerCheck.message);
    return;
  }

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
        const { id, csrfToken } = parseResult.data;

        if (!verifyCsrfToken(state.csrfToken, csrfToken)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: invalid CSRF token");
          return;
        }

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

function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  state: PickerState,
  server: Server,
  onError: (err: Error) => void,
): void {
  const headerCheck = validateLoopbackPostHeaders(req, { allowedHosts: [state.hostHeader] });
  if (!headerCheck.ok) {
    res.writeHead(headerCheck.status, { "Content-Type": "text/plain" });
    res.end(headerCheck.message);
    return;
  }

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid request body");
      return;
    }
    const parseResult = CancelSchema.safeParse(parsed);
    if (!parseResult.success || !verifyCsrfToken(state.csrfToken, parseResult.data.csrfToken)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: invalid CSRF token");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      server.close();
    }, 100);
    onError(new UserCancelledError("Selection cancelled by user"));
  });
}

/** Read body with MAX_BODY_SIZE cap. Rejects oversized requests inline. */
function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  callback: (body: string) => void,
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
    callback(body);
  });
}

function handleNavigate(
  req: IncomingMessage,
  res: ServerResponse,
  config: PickerConfig,
  state: PickerState,
  signal: AbortSignal,
): void {
  const navigation = config.navigation;
  if (!navigation) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal error: navigation not configured");
    return;
  }
  const headerCheck = validateLoopbackPostHeaders(req, { allowedHosts: [state.hostHeader] });
  if (!headerCheck.ok) {
    res.writeHead(headerCheck.status, { "Content-Type": "text/plain" });
    res.end(headerCheck.message);
    return;
  }

  readBody(req, res, (body) => {
    void (async () => {
      try {
        const parseResult = NavigateSchema.safeParse(JSON.parse(body));
        if (!parseResult.success) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid request body");
          return;
        }
        const { id, csrfToken } = parseResult.data;

        if (!verifyCsrfToken(state.csrfToken, csrfToken)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: invalid CSRF token");
          return;
        }

        const match = state.options.find((opt) => opt.id === id);
        if (!match) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid selection");
          return;
        }

        const result = await navigation.onNavigate(match, signal);
        state.options = result.options;
        state.breadcrumb = result.breadcrumb;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, options: result.options, breadcrumb: result.breadcrumb }),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("picker navigate failed", { error: message });
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error: ${message}`);
      }
    })();
  });
}

function handleSelectCurrent(
  req: IncomingMessage,
  res: ServerResponse,
  config: PickerConfig,
  state: PickerState,
  server: Server,
  onSelected: (result: PickerResult) => void,
  signal: AbortSignal,
): void {
  const navigation = config.navigation;
  if (!navigation) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal error: navigation not configured");
    return;
  }
  const headerCheck = validateLoopbackPostHeaders(req, { allowedHosts: [state.hostHeader] });
  if (!headerCheck.ok) {
    res.writeHead(headerCheck.status, { "Content-Type": "text/plain" });
    res.end(headerCheck.message);
    return;
  }

  readBody(req, res, (body) => {
    void (async () => {
      try {
        const parseResult = SelectCurrentSchema.safeParse(JSON.parse(body));
        if (!parseResult.success) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid request body");
          return;
        }
        const { csrfToken } = parseResult.data;

        if (!verifyCsrfToken(state.csrfToken, csrfToken)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: invalid CSRF token");
          return;
        }

        const result = await navigation.onSelectCurrent(signal);
        logger.info("picker select-current made", { id: result.id, label: result.label });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

        setTimeout(() => {
          server.close();
          onSelected({ selected: { id: result.id, label: result.label } });
        }, 100);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("picker select-current failed", { error: message });
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error: ${message}`);
      }
    })();
  });
}

function handleShareUrl(
  req: IncomingMessage,
  res: ServerResponse,
  config: PickerConfig,
  state: PickerState,
  server: Server,
  onSelected: (result: PickerResult) => void,
  signal: AbortSignal,
): void {
  // Top-level `onShareUrl` wins over navigation's, mirroring the
  // routing condition above.
  const onShareUrl = config.onShareUrl ?? config.navigation?.onShareUrl;
  if (onShareUrl === undefined) {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Share URL not supported");
    return;
  }
  const headerCheck = validateLoopbackPostHeaders(req, { allowedHosts: [state.hostHeader] });
  if (!headerCheck.ok) {
    res.writeHead(headerCheck.status, { "Content-Type": "text/plain" });
    res.end(headerCheck.message);
    return;
  }

  readBody(req, res, (body) => {
    void (async () => {
      try {
        const parseResult = ShareUrlSchema.safeParse(JSON.parse(body));
        if (!parseResult.success) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid request body");
          return;
        }
        const { url, csrfToken } = parseResult.data;

        if (!verifyCsrfToken(state.csrfToken, csrfToken)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: invalid CSRF token");
          return;
        }

        try {
          const result = await onShareUrl(url, signal);
          if (result.kind === "jump") {
            state.options = result.options;
            state.breadcrumb = result.breadcrumb;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                kind: "jump",
                options: result.options,
                breadcrumb: result.breadcrumb,
              }),
            );
          } else {
            logger.info("picker share-url selected", {
              id: result.selected.id,
              label: result.selected.label,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, kind: "select", selected: result.selected }));
            setTimeout(() => {
              server.close();
              onSelected({ selected: result.selected });
            }, 100);
          }
        } catch (err: unknown) {
          // User-facing errors are passed through verbatim; internal errors
          // are masked to avoid leaking stack traces / internals.
          const isUserFacing =
            err instanceof InvalidShareUrlError ||
            err instanceof ShareNotFoundError ||
            err instanceof ShareAccessDeniedError;
          const message =
            isUserFacing && err instanceof Error ? err.message : "Failed to resolve URL";
          if (!isUserFacing) {
            logger.error("picker share-url resolution failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("picker share-url handler failed", { error: message });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    })();
  });
}
