// Local HTTP server for todo list configuration.
//
// Serves a simple HTML page with clickable todo list options.
// When the user selects a list, the server saves the config and shuts down.
// This ensures only a human (via the browser) can change the active list.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

import { saveConfig } from "../config.js";
import { logger } from "../logger.js";

interface TodoListOption {
  id: string;
  displayName: string;
}

export interface ConfigServerResult {
  listId: string;
  listName: string;
}

export interface ConfigServerHandle {
  /** URL where the config page is served. */
  url: string;
  /** Resolves when the user makes a selection (or rejects on timeout/error). */
  waitForSelection: Promise<ConfigServerResult>;
}

/**
 * Start a local config server. Returns the URL immediately and a promise
 * that resolves when the user picks a list.
 */
export function startConfigServer(
  lists: TodoListOption[],
  configDir: string,
  opts?: { timeoutMs?: number },
): Promise<ConfigServerHandle> {
  const timeoutMs = opts?.timeoutMs ?? 120_000; // 2 minutes

  return new Promise<ConfigServerHandle>((resolveHandle, rejectHandle) => {
    let onSelected: (result: ConfigServerResult) => void;
    let onError: (err: Error) => void;

    const waitForSelection = new Promise<ConfigServerResult>(
      (resolve, reject) => {
        onSelected = resolve;
        onError = reject;
      },
    );

    const server = createServer((req, res) => {
      handleRequest(req, res, lists, configDir, server, onSelected);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        const err = new Error("Failed to get server address");
        rejectHandle(err);
        return;
      }
      const url = `http://127.0.0.1:${String(addr.port)}`;
      logger.info("config server started", { url });
      resolveHandle({ url, waitForSelection });
    });

    server.on("error", (err) => {
      logger.error("config server error", { error: err.message });
      rejectHandle(err);
    });

    // Timeout — shut down if user doesn't respond
    const timer = setTimeout(() => {
      logger.warn("config server timed out");
      server.close();
      onError(
        new Error(
          "Configuration timed out — no selection made within 2 minutes. " +
            "Run the todo_config tool again to retry.",
        ),
      );
    }, timeoutMs);

    server.on("close", () => {
      clearTimeout(timer);
    });
  });
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  lists: TodoListOption[],
  configDir: string,
  server: Server,
  onSelected: (result: ConfigServerResult) => void,
): void {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/") {
    serveConfigPage(res, lists);
    return;
  }

  if (req.method === "POST" && url === "/select") {
    handleSelection(req, res, lists, configDir, server, onSelected);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function serveConfigPage(
  res: ServerResponse,
  lists: TodoListOption[],
): void {
  const listItems = lists
    .map(
      (l) =>
        `<button class="list-btn" data-id="${escapeHtml(l.id)}" data-name="${escapeHtml(l.displayName)}">${escapeHtml(l.displayName)}</button>`,
    )
    .join("\n          ");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo — Configure Todo List</title>
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
    .list-btn {
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
    .list-btn:hover { border-color: #0078d4; box-shadow: 0 2px 8px rgba(0,120,212,0.15); }
    .list-btn:active { background: #f0f7ff; }
    .list-btn.selected { border-color: #0078d4; background: #f0f7ff; pointer-events: none; }
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
      <h1>Configure Todo List</h1>
      <p class="subtitle">Select which Microsoft To Do list graphdo should use:</p>
      ${listItems}
    </div>
    <div id="done" style="display:none" class="done">
      <h2>&#10003; Configured</h2>
      <p>Using list: <strong id="selected-name"></strong></p>
      <p style="margin-top: 24px;">You can switch back to your AI assistant now.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
    </div>
    <div id="error" class="error" style="display:none"></div>
  </div>
  <script>
    document.querySelectorAll('.list-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const name = btn.dataset.name;
        btn.classList.add('selected');
        document.querySelectorAll('.list-btn').forEach(b => { b.disabled = true; });
        try {
          const res = await fetch('/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ listId: id, listName: name }),
          });
          if (!res.ok) throw new Error(await res.text());
          document.getElementById('picker').style.display = 'none';
          document.getElementById('selected-name').textContent = name;
          document.getElementById('done').style.display = 'block';
          let remaining = 5;
          const el = document.getElementById('countdown');
          const tick = setInterval(() => {
            remaining--;
            el.textContent = String(remaining);
            if (remaining <= 0) { clearInterval(tick); window.close(); }
          }, 1000);
        } catch (err) {
          document.getElementById('error').style.display = 'block';
          document.getElementById('error').textContent = 'Failed to save: ' + err.message;
          document.querySelectorAll('.list-btn').forEach(b => { b.disabled = false; });
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
  lists: TodoListOption[],
  configDir: string,
  server: Server,
  onSelected: (result: ConfigServerResult) => void,
): void {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    void (async () => {
      try {
        const { listId } = JSON.parse(body) as {
          listId: string;
          listName: string;
        };

        // Validate the selection is one of the offered lists
        const match = lists.find((l) => l.id === listId);
        if (!match) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid list selection");
          return;
        }

        await saveConfig(
          { todoListId: match.id, todoListName: match.displayName },
          configDir,
        );

        logger.info("todo list configured via browser", {
          listId: match.id,
          listName: match.displayName,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

        // Shut down the server after a brief delay to let the response flush
        setTimeout(() => {
          server.close();
          onSelected({ listId: match.id, listName: match.displayName });
        }, 100);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("config selection failed", { error: message });
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
