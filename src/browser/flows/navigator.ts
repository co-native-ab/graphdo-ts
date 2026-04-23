// Navigator flow descriptor — browser-based workspace folder navigator.
//
// Provides a navigable browser UI for selecting a workspace folder from
// the signed-in user's own OneDrive. The picker is reachable only via the
// human-only `markdown_select_workspace` tool — the AI agent cannot
// programmatically change the configured workspace.
//
// Routes:
//   GET  /                page (initial folder listing rendered server-side)
//   GET  /children?…      JSON list of immediate child folders + breadcrumbs
//   POST /select          persist the current folder as the workspace
//   POST /cancel          tear the server down
//
// Like every other browser flow, the local server runs on 127.0.0.1, ships
// a per-request CSP nonce, and pins POST handlers behind a CSRF token.

import { z } from "zod";

import { UserCancelledError } from "../../errors.js";
import {
  GraphRequestError,
  HttpMethod,
  parseResponse,
  type GraphClient,
} from "../../graph/client.js";
import { driveItemPath, driveRootChildrenPath, type DriveScope } from "../../graph/drives.js";
import { tryValidateGraphId, validateGraphId, type ValidatedGraphId } from "../../graph/ids.js";
import { DriveItemSchema, GraphListResponseSchema } from "../../graph/types.js";
import { logger } from "../../logger.js";
import { navigatorPageHtml } from "../../templates/navigator.js";
import type { BrowserFlow, FlowContext, RouteTable } from "../server.js";
import { readJsonWithCsrf, respondAndClose, runBrowserFlow, serveHtml } from "../server.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NavigatorSelection {
  readonly scope: DriveScope;
  /** Display name of the resolved drive (e.g. `"OneDrive"`). */
  readonly driveName: string;
  /** The selected folder's drive item id. */
  readonly itemId: ValidatedGraphId;
  /** The selected folder's display name. */
  readonly itemName: string;
  /** Slash-joined display path within the drive (e.g. `/Notes/2026`). */
  readonly itemPath: string;
}

export interface NavigatorResult {
  readonly selected: NavigatorSelection;
}

export interface NavigatorConfig {
  readonly title: string;
  readonly subtitle: string;
  /** The drive the navigator opens to (always the user's own OneDrive today). */
  readonly initialScope: DriveScope;
  readonly client: GraphClient;
  /** Called inside the flow's signal scope when the user picks a folder. */
  readonly onSelect: (selection: NavigatorSelection, signal: AbortSignal) => Promise<void>;
  readonly timeoutMs?: number;
}

export interface NavigatorHandle {
  readonly url: string;
  readonly waitForSelection: Promise<NavigatorResult>;
}

// ---------------------------------------------------------------------------
// HTTP body schemas
// ---------------------------------------------------------------------------

const ChildrenQuerySchema = z.object({
  /** `"root"` for the drive root, otherwise an opaque drive item id. */
  itemId: z.string().min(1),
});

const SelectionSchema = z.object({
  itemId: z.string().min(1),
  itemName: z.string().min(1),
  itemPath: z.string().min(1),
  csrfToken: z.string(),
});

const CancelSchema = z.object({
  csrfToken: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FolderChild {
  readonly id: ValidatedGraphId;
  readonly name: string;
}

async function listChildFolders(
  client: GraphClient,
  scope: DriveScope,
  itemId: ValidatedGraphId | "root",
  signal: AbortSignal,
): Promise<FolderChild[]> {
  const path =
    itemId === "root"
      ? driveRootChildrenPath(scope, "?$top=200")
      : driveItemPath(scope, itemId, "/children?$top=200");
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(
    response,
    GraphListResponseSchema(DriveItemSchema),
    HttpMethod.GET,
    path,
  );
  const out: FolderChild[] = [];
  for (const item of data.value) {
    if (item.folder === undefined) continue;
    const validated = tryValidateGraphId("driveItem.id", item.id);
    if (!validated.ok) {
      logger.warn("navigator: skipping child with invalid id", {
        reason: validated.reason,
        rawId: item.id,
      });
      continue;
    }
    out.push({ id: validated.value, name: item.name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

interface FolderInfo {
  readonly name: string;
  /** Drive-relative display path (e.g. `/Notes/2026`). */
  readonly path: string;
}

async function getFolderInfo(
  client: GraphClient,
  scope: DriveScope,
  itemId: ValidatedGraphId | "root",
  signal: AbortSignal,
): Promise<FolderInfo> {
  if (itemId === "root") return { name: "/", path: "/" };
  const path = driveItemPath(scope, itemId);
  const response = await client.request(HttpMethod.GET, path, signal);
  const item = await parseResponse(response, DriveItemSchema, HttpMethod.GET, path);
  // parentReference.path looks like `/drive/root:/Notes` or `/drives/{id}/root:/Notes`.
  // Strip the prefix and append the item name.
  const parentPath = item.parentReference?.path ?? "";
  const match = /(?:\/drive|\/drives\/[^/]+)\/root:(.*)$/.exec(parentPath);
  const parent = match?.[1] ?? "";
  const trimmedParent = parent === "" ? "" : parent.replace(/\/+$/, "");
  const display = `${trimmedParent}/${item.name}`;
  return { name: item.name, path: display.startsWith("/") ? display : `/${display}` };
}

// ---------------------------------------------------------------------------
// navigatorFlow descriptor
// ---------------------------------------------------------------------------

export function navigatorFlow(
  config: NavigatorConfig,
  signal: AbortSignal,
): BrowserFlow<NavigatorResult> {
  // Today the navigator only ever operates on the user's own OneDrive, so
  // the drive label is fixed for the lifetime of the flow.
  const driveLabel = "OneDrive";

  return {
    name: "navigator",
    timeoutMs: config.timeoutMs,
    routes: (ctx: FlowContext<NavigatorResult>): RouteTable => {
      return {
        "GET /": (_req, res, nonce) => {
          try {
            serveHtml(
              res,
              navigatorPageHtml({
                title: config.title,
                subtitle: config.subtitle,
                driveLabel,
                csrfToken: ctx.csrfToken,
                nonce,
              }),
            );
          } catch (err: unknown) {
            logger.error("navigator initial page render failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Failed to render workspace navigator");
          }
        },

        "GET /children": (req, res) => {
          void (async () => {
            try {
              const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
              const parsed = ChildrenQuerySchema.safeParse({
                itemId: url.searchParams.get("itemId"),
              });
              if (!parsed.success) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid itemId" }));
                return;
              }
              const itemId =
                parsed.data.itemId === "root"
                  ? ("root" as const)
                  : validateGraphId("itemId", parsed.data.itemId);
              const [info, folders] = await Promise.all([
                getFolderInfo(config.client, config.initialScope, itemId, signal),
                listChildFolders(config.client, config.initialScope, itemId, signal),
              ]);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  itemId: parsed.data.itemId,
                  itemName: info.name,
                  itemPath: info.path,
                  folders: folders.map((f) => ({ id: f.id, name: f.name })),
                  driveLabel,
                }),
              );
            } catch (err: unknown) {
              if (signal.aborted) return;
              const message =
                err instanceof GraphRequestError
                  ? err.graphMessage
                  : err instanceof Error
                    ? err.message
                    : String(err);
              logger.warn("navigator children load failed", { error: message });
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: message }));
            }
          })();
        },

        "POST /select": (req, res) => {
          readJsonWithCsrf(req, res, ctx, SelectionSchema, async (data) => {
            try {
              const itemId = validateGraphId("itemId", data.itemId);
              const selection: NavigatorSelection = {
                scope: config.initialScope,
                driveName: driveLabel,
                itemId,
                itemName: data.itemName,
                itemPath: data.itemPath,
              };
              await config.onSelect(selection, signal);
              respondAndClose(res, ctx.server, { ok: true, label: data.itemName });
              ctx.resolve({ selected: selection });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              logger.error("navigator selection persist failed", { error: message });
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: message }));
            }
          });
        },

        "POST /cancel": (req, res) => {
          readJsonWithCsrf(req, res, ctx, CancelSchema, () => {
            respondAndClose(res, ctx.server, { ok: true });
            ctx.reject(new UserCancelledError("Workspace selection cancelled by user"));
          });
        },
      };
    },
  };
}

/**
 * Start a local navigator server. Returns the URL to surface to the user
 * and a promise that resolves when they pick a folder (or rejects on
 * cancel / timeout / abort).
 */
export async function runNavigator(
  config: NavigatorConfig,
  signal: AbortSignal,
): Promise<NavigatorHandle> {
  const handle = await runBrowserFlow(navigatorFlow(config, signal), signal);
  return {
    url: handle.url,
    waitForSelection: handle.result,
  };
}
