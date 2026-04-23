// Navigator flow descriptor — browser-based workspace folder navigator.
//
// Provides a navigable browser UI for selecting a workspace folder from any
// accessible drive: the user's own OneDrive, or a shared drive/folder via
// pasted share link.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { UserCancelledError } from "../../errors.js";
import type { GraphClient } from "../../graph/client.js";
import { HttpMethod } from "../../graph/client.js";
import type { DriveScope } from "../../graph/drives.js";
import { driveItemPath, driveMetadataPath, driveRootChildrenPath, meDriveScope, resolveShareLink } from "../../graph/drives.js";
import type { ValidatedGraphId } from "../../graph/ids.js";
import { validateGraphId } from "../../graph/ids.js";
import { logger } from "../../logger.js";
import { navigatorPageHtml } from "../../templates/navigator.js";
import type { BrowserFlow, FlowContext, RouteTable } from "../server.js";
import { readJsonWithCsrf, respondAndClose, runBrowserFlow } from "../server.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NavigatorSelection {
  scope: DriveScope;
  itemId: ValidatedGraphId;
  name: string;
  path: string;
}

export interface NavigatorConfig {
  title: string;
  subtitle: string;
  /** The drive and folder to show when the navigator first opens. */
  initialScope: DriveScope;
  /** Graph client for fetching folder children and resolving share links. */
  client: GraphClient;
  /** Called when the user selects a folder. */
  onSelect: (selection: NavigatorSelection, signal: AbortSignal) => Promise<void>;
  /** Timeout in milliseconds (default: 120_000 - 2 minutes). */
  timeoutMs?: number;
}

export interface NavigatorResult {
  selected: NavigatorSelection;
}

export interface NavigatorHandle {
  url: string;
  waitForSelection: Promise<NavigatorResult>;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ChildrenQuerySchema = z.object({
  scope: z.string(),
  itemId: z.string(),
});

const ResolveShareBodySchema = z.object({
  url: z.string(),
  csrfToken: z.string(),
});

const SelectionSchema = z.object({
  driveId: z.string(),
  itemId: z.string(),
  path: z.string(),
  csrfToken: z.string(),
});

const CancelSchema = z.object({
  csrfToken: z.string(),
});

// ---------------------------------------------------------------------------
// Helper: parse folder children from Graph response
// ---------------------------------------------------------------------------

async function loadFolderChildren(
  client: GraphClient,
  scope: DriveScope,
  itemId: ValidatedGraphId | "root",
  signal: AbortSignal,
): Promise<Array<{ id: ValidatedGraphId; name: string }>> {
  const path = itemId === "root"
    ? driveRootChildrenPath(scope)
    : driveItemPath(scope, itemId, "/children");

  const res = await client.request(HttpMethod.GET, path, signal);
  if (!res.ok) {
    const { parseResponse, GraphRequestError } = await import("../../graph/client.js");
    const err = await GraphRequestError.fromResponse(res, HttpMethod.GET, path);
    throw err;
  }

  const { parseResponse } = await import("../../graph/client.js");
  const { GraphListResponseSchema, DriveItemSchema } = await import("../../graph/types.js");
  
  const data = await parseResponse(res, GraphListResponseSchema(DriveItemSchema), signal);
  
  // Filter to folders only and validate IDs
  const folders: Array<{ id: ValidatedGraphId; name: string }> = [];
  for (const item of data.value) {
    if (item.folder !== undefined) {
      folders.push({
        id: validateGraphId("folder item id", item.id),
        name: item.name,
      });
    }
  }
  
  return folders;
}

// ---------------------------------------------------------------------------
// Helper: build breadcrumbs from Graph item metadata
// ---------------------------------------------------------------------------

interface Breadcrumb {
  id: string;
  label: string;
}

async function loadBreadcrumbs(
  client: GraphClient,
  scope: DriveScope,
  itemId: ValidatedGraphId | "root",
  signal: AbortSignal,
): Promise<{ breadcrumbs: Breadcrumb[]; currentName: string }> {
  if (itemId === "root") {
    return {
      breadcrumbs: [{ id: "root", label: "/" }],
      currentName: "/",
    };
  }

  const path = driveItemPath(scope, itemId);
  const res = await client.request(HttpMethod.GET, path, signal);
  if (!res.ok) {
    const { parseResponse, GraphRequestError } = await import("../../graph/client.js");
    const err = await GraphRequestError.fromResponse(res, HttpMethod.GET, path);
    throw err;
  }

  const { parseResponse } = await import("../../graph/client.js");
  const { DriveItemSchema } = await import("../../graph/types.js");
  const item = await parseResponse(res, DriveItemSchema, signal);

  // Build breadcrumbs from parent path (Graph returns `/drive/root:/path/to/folder`)
  const breadcrumbs: Breadcrumb[] = [{ id: "root", label: "/" }];
  
  if (item.parentReference?.path) {
    // Extract path segments after "/drive/root:"
    const match = item.parentReference.path.match(/\/drive\/root:(.*)$/);
    if (match && match[1]) {
      const segments = match[1].split("/").filter(Boolean);
      // We don't have IDs for intermediate segments from this response, so we can't make them clickable
      // For now, just show them as non-clickable text (future PR can add path-to-id resolution)
    }
  }
  
  // Add current folder as the last segment
  breadcrumbs.push({ id: itemId, label: item.name });

  return {
    breadcrumbs,
    currentName: item.name,
  };
}

// ---------------------------------------------------------------------------
// Helper: load drive name
// ---------------------------------------------------------------------------

async function getDriveName(
  client: GraphClient,
  scope: DriveScope,
  signal: AbortSignal,
): Promise<string> {
  if (scope.kind === "me") {
    return "OneDrive";
  }

  const path = driveMetadataPath(scope);
  const res = await client.request(HttpMethod.GET, path, signal);
  if (!res.ok) {
    // Fallback to drive ID if we can't load metadata
    return scope.driveId;
  }

  const { parseResponse } = await import("../../graph/client.js");
  const { DriveSchema } = await import("../../graph/types.js");
  const drive = await parseResponse(res, DriveSchema, signal);
  return drive.name ?? scope.driveId;
}

// ---------------------------------------------------------------------------
// navigatorFlow descriptor
// ---------------------------------------------------------------------------

export function navigatorFlow(
  config: NavigatorConfig,
  signal: AbortSignal,
): BrowserFlow<NavigatorResult> {
  return {
    name: "navigator",
    timeoutMs: config.timeoutMs,
    routes: (ctx: FlowContext<NavigatorResult>): RouteTable => {
      // Mutable state: discovered drives (starts with just the initial scope)
      const state = {
        drives: [
          {
            id: config.initialScope.kind === "me" ? "me" : config.initialScope.driveId,
            label: "OneDrive",
            scope: config.initialScope,
          },
        ],
      };

      return {
        "GET /": async (_req, res, nonce) => {
          try {
            // Load initial folder listing
            const folders = await loadFolderChildren(
              config.client,
              config.initialScope,
              "root",
              signal,
            );
            
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              navigatorPageHtml({
                title: config.title,
                subtitle: config.subtitle,
                drives: state.drives.map((d) => ({ id: d.id, label: d.label })),
                activeDriveId: state.drives[0]?.id ?? "me",
                breadcrumbs: [{ id: "root", label: "/" }],
                folders: folders.map((f) => ({ id: f.id, name: f.name })),
                csrfToken: ctx.csrfToken,
                nonce,
              }),
            );
          } catch (err: unknown) {
            logger.error("navigator initial load failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Failed to load initial folder listing");
          }
        },

        "GET /children": (req, res) => {
          void (async () => {
            try {
              const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
              const rawScope = url.searchParams.get("scope");
              const rawItemId = url.searchParams.get("itemId");

              const parsed = ChildrenQuerySchema.safeParse({
                scope: rawScope,
                itemId: rawItemId,
              });
              if (!parsed.success) {
                res.writeHead(400, { "Content-Type": "text/plain" });
                res.end("Invalid query parameters");
                return;
              }

              // Build DriveScope from the scope parameter
              const scope: DriveScope =
                parsed.data.scope === "me"
                  ? meDriveScope
                  : { kind: "drive", driveId: validateGraphId("driveId", parsed.data.scope) };

              const itemId =
                parsed.data.itemId === "root"
                  ? "root"
                  : validateGraphId("itemId", parsed.data.itemId);

              const folders = await loadFolderChildren(config.client, scope, itemId, signal);
              const { breadcrumbs, currentName } = await loadBreadcrumbs(
                config.client,
                scope,
                itemId,
                signal,
              );

              const path = breadcrumbs.map((b) => b.label).join("/").replace(/\/+/g, "/");

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  folders: folders.map((f) => ({ id: f.id, name: f.name })),
                  breadcrumbs,
                  path,
                }),
              );
            } catch (err: unknown) {
              logger.error("navigator children load failed", {
                error: err instanceof Error ? err.message : String(err),
              });
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Failed to load folder children");
            }
          })();
        },

        "POST /resolve-share": (req, res) => {
          readJsonWithCsrf(req, res, ctx, ResolveShareBodySchema, async (data) => {
            try {
              const resolved = await resolveShareLink(config.client, data.url, signal);

              // Add the new drive to state
              const driveId = resolved.driveId;
              const driveName = await getDriveName(
                config.client,
                { kind: "drive", driveId },
                signal,
              );

              // Check if already added
              const exists = state.drives.some((d) => d.id === driveId);
              if (!exists) {
                state.drives.push({
                  id: driveId,
                  label: driveName,
                  scope: { kind: "drive", driveId },
                });
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  driveId,
                  itemId: resolved.itemId,
                  name: resolved.name,
                }),
              );
              logger.info("share link resolved", { driveId, itemId: resolved.itemId });
            } catch (err: unknown) {
              logger.error("share link resolution failed", {
                error: err instanceof Error ? err.message : String(err),
              });
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end(
                err instanceof Error ? err.message : "Failed to resolve share link",
              );
            }
          });
        },

        "POST /select": (req, res) => {
          readJsonWithCsrf(req, res, ctx, SelectionSchema, async (data) => {
            try {
              // Build scope from driveId
              const scope: DriveScope =
                data.driveId === "me"
                  ? meDriveScope
                  : { kind: "drive", driveId: validateGraphId("driveId", data.driveId) };

              const itemId = validateGraphId("itemId", data.itemId);

              // Load the item to get its name
              const { breadcrumbs, currentName } = await loadBreadcrumbs(
                config.client,
                scope,
                itemId,
                signal,
              );

              const selection: NavigatorSelection = {
                scope,
                itemId,
                name: currentName,
                path: data.path,
              };

              await config.onSelect(selection, signal);

              logger.info("navigator selection made", {
                driveId: data.driveId,
                itemId: data.itemId,
                path: data.path,
              });

              respondAndClose(res, ctx.server, { ok: true });
              ctx.resolve({ selected: selection });
            } catch (err: unknown) {
              logger.error("navigator selection failed", {
                error: err instanceof Error ? err.message : String(err),
              });
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end(err instanceof Error ? err.message : "Selection failed");
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

// ---------------------------------------------------------------------------
// runNavigator — public wrapper
// ---------------------------------------------------------------------------

/**
 * Start a local navigator server. Returns the URL immediately and a promise
 * that resolves when the user selects a workspace folder.
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
