// Generic browser-based picker — local HTTP server serving an HTML selection page.
//
// Serves a page with clickable options. When the user selects one, the callback
// is invoked and the server shuts down. Reusable for any browser-based selection
// (todo list config, account picker, etc.).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PickerOption {
  id: string;
  label: string;
}

export interface PickerConfig {
  title: string;
  subtitle: string;
  options: PickerOption[];
  /** Called when the user selects an option. Errors are surfaced to the browser. */
  onSelect: (option: PickerOption) => Promise<void>;
  /** Timeout in milliseconds (default: 120 000 — 2 minutes). */
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
// Picker server
// ---------------------------------------------------------------------------

/**
 * Start a local picker server. Returns the URL immediately and a promise
 * that resolves when the user picks an option.
 */
export function startBrowserPicker(config: PickerConfig): Promise<PickerHandle> {
  const timeoutMs = config.timeoutMs ?? 120_000;

  return new Promise<PickerHandle>((resolveHandle, rejectHandle) => {
    let onSelected: (result: PickerResult) => void;
    let onError: (err: Error) => void;

    const waitForSelection = new Promise<PickerResult>((resolve, reject) => {
      onSelected = resolve;
      onError = reject;
    });

    const server = createServer((req, res) => {
      handleRequest(req, res, config, server, onSelected);
    });

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
        new Error(
          "Selection timed out — no choice made within the time limit. Please try again.",
        ),
      );
    }, timeoutMs);

    server.on("close", () => {
      clearTimeout(timer);
    });
  });
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: PickerConfig,
  server: Server,
  onSelected: (result: PickerResult) => void,
): void {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/") {
    servePickerPage(res, config);
    return;
  }

  if (req.method === "POST" && url === "/select") {
    handleSelection(req, res, config, server, onSelected);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function servePickerPage(res: ServerResponse, config: PickerConfig): void {
  const optionButtons = config.options
    .map(
      (opt) =>
        `<button class="option-btn" data-id="${escapeHtml(opt.id)}" data-label="${escapeHtml(opt.label)}">${escapeHtml(opt.label)}</button>`,
    )
    .join("\n          ");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo — ${escapeHtml(config.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #333;
      display: flex;
      justify-content: center;
      padding: 40px 20px;
    }
    .container { max-width: 480px; width: 100%; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; font-size: 0.95rem; }
    .option-btn {
      display: block;
      width: 100%;
      padding: 14px 18px;
      margin-bottom: 10px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .option-btn:hover { border-color: #0078d4; box-shadow: 0 2px 8px rgba(0,120,212,0.15); }
    .option-btn:active { background: #f0f7ff; }
    .option-btn.selected { border-color: #0078d4; background: #f0f7ff; pointer-events: none; }
    .done { text-align: center; padding: 32px 0; }
    .done h2 { color: #107c10; margin-bottom: 8px; }
    .done p { color: #666; }
    .error { color: #d13438; margin-top: 16px; }
    .countdown { color: #999; margin-top: 8px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <div id="picker">
      <h1>${escapeHtml(config.title)}</h1>
      <p class="subtitle">${escapeHtml(config.subtitle)}</p>
      ${optionButtons}
    </div>
    <div id="done" style="display:none" class="done">
      <h2>&#10003; Done</h2>
      <p>Selected: <strong id="selected-label"></strong></p>
      <p style="margin-top: 24px;">You can switch back to your AI assistant now.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
      <p id="manual-close" style="display:none; margin-top: 16px; color: #666; font-size: 0.9rem;">If this window didn&rsquo;t close automatically, please close it manually.</p>
    </div>
    <div id="error" class="error" style="display:none"></div>
  </div>
  <script>
    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const label = btn.dataset.label;
        btn.classList.add('selected');
        document.querySelectorAll('.option-btn').forEach(b => { b.disabled = true; });
        try {
          const res = await fetch('/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, label: label }),
          });
          if (!res.ok) throw new Error(await res.text());
          document.getElementById('picker').style.display = 'none';
          document.getElementById('selected-label').textContent = label;
          document.getElementById('done').style.display = 'block';
          let remaining = 5;
          const el = document.getElementById('countdown');
          const tick = setInterval(() => {
            remaining--;
            el.textContent = String(remaining);
            if (remaining <= 0) {
              clearInterval(tick);
              window.close();
              setTimeout(() => {
                document.getElementById('countdown').parentElement.style.display = 'none';
                document.getElementById('manual-close').style.display = 'block';
              }, 500);
            }
          }, 1000);
        } catch (err) {
          document.getElementById('error').style.display = 'block';
          document.getElementById('error').textContent = 'Failed: ' + err.message;
          document.querySelectorAll('.option-btn').forEach(b => { b.disabled = false; });
          btn.classList.remove('selected');
        }
      });
    });
  </script>
</body>
</html>`;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function handleSelection(
  req: IncomingMessage,
  res: ServerResponse,
  config: PickerConfig,
  server: Server,
  onSelected: (result: PickerResult) => void,
): void {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    void (async () => {
      try {
        const { id } = JSON.parse(body) as { id: string; label: string };

        // Validate the selection against offered options
        const match = config.options.find((opt) => opt.id === id);
        if (!match) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid selection");
          return;
        }

        await config.onSelect(match);

        logger.info("picker selection made", { id: match.id, label: match.label });

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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
