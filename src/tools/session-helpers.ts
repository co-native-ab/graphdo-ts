// Internal helpers shared by the `session_*` tool runners (not part of the
// public API). Split out from `./session.ts`.

import type { ServerConfig } from "../index.js";
import { writeAudit, AuditResult } from "../collab/audit.js";

/**
 * Convert a `Date` to an ISO 8601 string with an explicit UTC offset
 * (`...Z`). The `ProjectMetadata` schema requires `offset: true` so a
 * naked `toISOString()` (which already emits `Z`, an offset) is fine —
 * this wrapper exists so future test environments that replace `now`
 * with a non-UTC clock get a consistent shape.
 */
export function toIsoOffset(d: Date): string {
  return d.toISOString();
}

/**
 * Build a user-facing folder path from the parent reference returned by
 * Graph (`/drive/root:` or `/drive/root:/<parent>/<grand-parent>`) plus
 * the folder's own name. Returns `/<folderName>` when the parent path
 * cannot be parsed so we always have a non-empty value to record.
 */
export function derivedFolderPath(parentPath: string | undefined, folderName: string): string {
  if (parentPath === undefined || parentPath.length === 0) {
    return `/${folderName}`;
  }
  // `parentReference.path` looks like `/drive/root:` or
  // `/drive/root:/Documents/Project Foo`. Strip the well-known
  // `/drive/root:` prefix to expose just the user-meaningful path.
  const prefix = "/drive/root:";
  const relative = parentPath.startsWith(prefix) ? parentPath.slice(prefix.length) : parentPath;
  const cleanedParent = relative.length === 0 || relative === "/" ? "" : relative;
  return `${cleanedParent}/${folderName}`;
}

/**
 * Last 8 chars of an Entra `oid` UUID (with hyphens stripped) — only
 * surfaced in `session_status` output to keep that text grep-friendly
 * while reminding operators the full id lives in the audit log.
 */
export function userOidSuffix(userOid: string): string {
  const flat = userOid.replace(/-/g, "");
  return flat.length <= 8 ? flat : flat.slice(-8);
}

/**
 * Compose the human-facing "we opened these browser windows for you"
 * preamble. Reports the folder picker and (W1 Day 4) the file picker
 * separately so the human knows which URLs to visit if the auto-open
 * fell back.
 */
export function renderOpeningMessage(args: {
  folderOpened: boolean;
  folderUrl: string;
  fileOpened: boolean;
  fileUrl: string;
}): string {
  const folderLine = args.folderOpened
    ? "A browser window opened so you could pick the project folder."
    : `Browser auto-open failed for the folder picker; you visited ${args.folderUrl} manually.`;
  const fileLine = args.fileOpened
    ? "A second window opened so you could confirm the authoritative markdown file."
    : `Browser auto-open failed for the file picker; you visited ${args.fileUrl} manually.`;
  return `${folderLine}\n${fileLine}`;
}

/**
 * Emit the warn-once-per-session `agent_name_unknown` audit envelope
 * (§3.6, §10 question 4) when the registry-derived agentId middle
 * segment is `"unknown"` — i.e. the connected MCP client's
 * `clientInfo.name` was missing, an empty string, or all-non-slug
 * characters. The registry's
 * {@link import("../collab/session.js").SessionRegistry.tryMarkAgentNameUnknownEmitted | tryMarkAgentNameUnknownEmitted}
 * guarantees the audit fires at most once per session, so subsequent
 * tool calls in the same session are silent.
 *
 * `clientInfoPresent` is `true` whenever the underlying MCP client
 * reported any `clientInfo` payload at all (even one with an empty
 * `name`); it is `false` only when the SDK returned no implementation
 * record. This matches the §3.6 row's intent (distinguish "client
 * forgot to send clientInfo" from "client sent clientInfo but with an
 * unusable name").
 */
export async function emitAgentNameUnknownIfNeeded(
  config: ServerConfig,
  session: { sessionId: string; agentId: string; userOid: string; projectId: string },
  clientInfo: { name?: string; version?: string } | undefined,
  signal: AbortSignal,
): Promise<void> {
  // `agentId` shape is `<oidPrefix>-<clientSlug>-<sessionPrefix>` (§B6.17).
  // Parsing the middle segment lets us key off the registry's slugifier
  // result without re-running it.
  const segments = session.agentId.split("-");
  const isUnknown = segments.length >= 3 && segments[1] === "unknown";
  if (!isUnknown) return;
  if (!config.sessionRegistry.tryMarkAgentNameUnknownEmitted()) return;

  await writeAudit(
    config,
    {
      sessionId: session.sessionId,
      agentId: session.agentId,
      userOid: session.userOid,
      projectId: session.projectId,
      result: AuditResult.Success,
      type: "agent_name_unknown",
      details: {
        clientInfoPresent: clientInfo !== undefined,
        agentIdAssigned: session.agentId,
      },
    },
    signal,
  );
}
