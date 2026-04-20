// MCP tools for managing a collab v1 session lifecycle:
//
//   - `session_init_project` (W1 Day 3 + W1 Day 4) — originator flow.
//   - `session_status` (W1 Day 5) — reports the active session's TTL,
//     budget counters, and source breakdown. Read-only.
//   - `session_open_project` (W4 Day 4) — collaborator flow.
//   - `session_renew`, `session_recover_doc_id` — later milestones. Empty
//     placeholders are NOT registered here — each tool is added in the
//     milestone that ships its DoD.
//
// W1 Day 4 adds multi-root-md handling: after the folder picker resolves,
// a second browser picker is opened to let the human pick the
// authoritative `.md` file. This picker is shown for every folder with
// ≥1 root `.md` files (including the N=1 case, where it pre-selects the
// only option for confirmation). A folder with zero root `.md` files
// continues to throw `NoMarkdownFileError`. Both pickers share the
// W0 form-factory slot, so concurrent tools always see the URL of the
// page the human is currently looking at in `FormBusyError`.
//
// W1 Day 5 wires `session_init_project` into the in-memory
// `SessionRegistry` (see `src/collab/session.ts`) and persists the
// destructive counter to `<configDir>/sessions/destructive-counts.json`
// per §3.7 so the file format survives a process restart. `session_status`
// is the first reader of the registry.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getMyDrive } from "../graph/markdown.js";
import { validateGraphId } from "../graph/ids.js";
import {
  AuthenticationRequiredError,
  NoMarkdownFileError,
  ProjectAlreadyInitialisedError,
  UserCancelledError,
} from "../errors.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import { startBrowserPicker } from "../picker.js";
import { GraphScope } from "../scopes.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";

import {
  SENTINEL_FOLDER_NAME,
  SENTINEL_SCHEMA_VERSION,
  writeSentinel,
  type ProjectSentinel,
} from "../collab/sentinel.js";
import {
  createChildFolder,
  findChildFolderByName,
  getDriveItem,
  listRootMarkdownFiles,
} from "../collab/graph.js";
import {
  saveProjectMetadata,
  loadProjectMetadata,
  upsertRecent,
  type ProjectMetadata,
  type RecentEntry,
} from "../collab/projects.js";
import { NoActiveSessionError, SessionAlreadyActiveError } from "../collab/session.js";
import { newUlid } from "../collab/ulid.js";
import { writeAudit, AuditResult } from "../collab/audit.js";
import { LeasesFileMissingError, readLeases } from "../collab/leases.js";
import { listRootFolders } from "../graph/markdown.js";

import { acquireFormSlot } from "./collab-forms.js";
import { formatError } from "./shared.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const SESSION_INIT_DEF: ToolDef = {
  name: "session_init_project",
  title: "Initialise Collab Project",
  description:
    "Start a new collaboration project. Opens a browser form where the human " +
    "selects the OneDrive folder, then a second browser form to choose the " +
    "authoritative markdown file at the root of that folder (auto-confirmed " +
    "when the folder contains exactly one). All parameters come from those " +
    "forms, not from this tool call. Writes a .collab/project.json sentinel " +
    "into the chosen folder, records the project locally, and adds a recents " +
    "entry. Returns the resulting projectId, folder path, and authoritative " +
    "file name. Use session_open_project to join an existing project as a " +
    "collaborator.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

const SESSION_STATUS_DEF: ToolDef = {
  name: "session_status",
  title: "Collab Session Status",
  description:
    "Report the active collaboration session's project, agent identity, " +
    "TTL, write/destructive/renewal counters, and per-source counters " +
    "(chat / project / external). Read-only and free — no Graph calls, " +
    "no destructive-budget cost. Returns a 'no active session' message " +
    "(not isError) when nothing is active. When the session is past its " +
    "TTL, returns 'expired: true' with the counters frozen so the agent " +
    "knows to call session_renew.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const SESSION_TOOL_DEFS: readonly ToolDef[] = [SESSION_INIT_DEF, SESSION_STATUS_DEF];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register `session_*` tools on the given MCP server. */
export function registerSessionTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  return [
    defineTool(
      server,
      SESSION_INIT_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_INIT_DEF.title,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (_args, { signal }) => {
        const slot = acquireFormSlot("session_init_project");
        try {
          return await runInitProject(config, slot, signal);
        } catch (err: unknown) {
          if (err instanceof UserCancelledError) {
            return {
              content: [{ type: "text", text: "Project initialisation cancelled." }],
            };
          }
          const isTimeout = err instanceof Error && err.message.toLowerCase().includes("timed out");
          const retryHint = isTimeout
            ? "\n\nThe user did not make a selection in time. " +
              "You can call this tool again if the user would like to retry."
            : "\n\nYou can call this tool again if the user would like to retry.";
          return formatError("session_init_project", err, { suffix: retryHint });
        } finally {
          slot.release();
        }
      },
    ),
    defineTool(
      server,
      SESSION_STATUS_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_STATUS_DEF.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (_args, { signal }) => {
        try {
          if (signal.aborted) throw signal.reason;
          return await runSessionStatus(config, signal);
        } catch (err: unknown) {
          return formatError("session_status", err);
        }
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Drive the originator init flow: pick a folder, validate it, write the
 * sentinel + pin block + recents. Throws on every error path so the
 * tool registration above can render them through `formatError`.
 */
async function runInitProject(
  config: ServerConfig,
  slot: { setUrl: (url: string) => void },
  signal: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const client = config.graphClient;
  const now = config.now ?? ((): Date => new Date());

  // Refuse early if a session is already active in this MCP instance —
  // §2.2 limits the process to one active session at a time. Checking
  // here (before opening any browser tab) keeps the failure mode
  // cheap: no picker URL to clean up, no `.collab/` write half-done.
  const existing = config.sessionRegistry.snapshot();
  if (existing !== null) {
    throw new SessionAlreadyActiveError(existing.projectId);
  }

  // Display name comes from the signed-in account so the sentinel's
  // `createdBy.displayName` reflects the human who initialised the
  // project. Fall back to the username (typically the email) when the
  // authenticator does not surface a display name yet.
  const account = await config.authenticator.accountInfo(signal);
  if (!account) {
    throw new AuthenticationRequiredError();
  }
  const createdByDisplayName = account.username;

  // ------- Browser picker: pick the project folder -------

  const folders = await listRootFolders(client, signal);
  if (folders.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "No top-level folders are available in your OneDrive. " +
            "Create a folder there first, then run session_init_project again.",
        },
      ],
    };
  }

  const handle = await startBrowserPicker(
    {
      title: "Select Collab Project Folder",
      subtitle:
        "Choose the OneDrive folder that will hold this collaboration project. " +
        "graphdo will create a .collab/ subfolder there to record the project's sentinel.",
      options: folders.map((f) => ({ id: f.id, label: `/${f.name}` })),
      filterPlaceholder: "Filter folders...",
      refreshOptions: async (s) => {
        const refreshed = await listRootFolders(client, s);
        return refreshed.map((f) => ({ id: f.id, label: `/${f.name}` }));
      },
      onSelect: async () => {
        // The init flow does its work after the picker resolves so the
        // slot's URL stays useful in FormBusyError messages until the
        // sentinel + metadata + recents writes complete.
      },
    },
    signal,
  );
  slot.setUrl(handle.url);

  let browserOpened = false;
  try {
    await config.openBrowser(handle.url);
    browserOpened = true;
    logger.info("session_init_project picker opened", { url: handle.url });
  } catch (err: unknown) {
    logger.warn("could not open browser for session_init_project", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const result = await handle.waitForSelection;
  // The picker option `id` started life as a Graph drive item id surfaced
  // by `listRootFolders`. Re-validate at this boundary so the value is
  // brand-typed before it threads through every collab Graph helper
  // (defence in depth — if a future picker option source produced a
  // non-Graph id we'd fail loudly here rather than splice into a URL).
  const chosenFolderId = validateGraphId("chosenFolderId", result.selected.id);

  // ------- Validate folder contents -------

  const collabExisting = await findChildFolderByName(
    client,
    chosenFolderId,
    SENTINEL_FOLDER_NAME,
    signal,
  );
  if (collabExisting !== null) {
    throw new ProjectAlreadyInitialisedError(chosenFolderId);
  }

  const markdownFiles = await listRootMarkdownFiles(client, chosenFolderId, signal);
  // Resolve the chosen folder up-front so error messages can use the
  // authoritative `name` from Graph rather than munging the picker label
  // (which carries a synthetic leading `/` to render the path).
  const folderItem = await getDriveItem(client, chosenFolderId, signal);

  if (markdownFiles.length === 0) {
    throw new NoMarkdownFileError(folderItem.name, chosenFolderId);
  }

  // ------- Browser picker: pick the authoritative .md file -------
  //
  // Always show a confirmation form, even for the N=1 case, so the
  // human explicitly authorises which file becomes the project's
  // authoritative source. The picker validates the selected id against
  // the list of root `.md` files reported by Graph, so the agent
  // cannot smuggle in a different drive item.

  const fileOptionsById = new Map(markdownFiles.map((f) => [f.id, f] as const));
  const fileSubtitle =
    markdownFiles.length === 1
      ? `Confirm "${markdownFiles[0]?.name ?? ""}" as the authoritative markdown file for "${folderItem.name}". This is the file collab tools will read and write.`
      : `Choose which markdown file at the root of "${folderItem.name}" is the authoritative source for this project. The other root .md files remain in the folder unmodified.`;
  const fileHandle = await startBrowserPicker(
    {
      title: "Select Authoritative Markdown File",
      subtitle: fileSubtitle,
      options: markdownFiles.map((f) => ({ id: f.id, label: f.name })),
      filterPlaceholder: "Filter files...",
      onSelect: async () => {
        // The init flow does its work after the picker resolves so the
        // slot's URL stays useful in FormBusyError messages until the
        // sentinel + metadata + recents writes complete.
      },
    },
    signal,
  );
  slot.setUrl(fileHandle.url);

  let fileBrowserOpened = false;
  try {
    await config.openBrowser(fileHandle.url);
    fileBrowserOpened = true;
    logger.info("session_init_project file picker opened", { url: fileHandle.url });
  } catch (err: unknown) {
    logger.warn("could not open browser for session_init_project file picker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const fileResult = await fileHandle.waitForSelection;
  const authoritativeFile = fileOptionsById.get(fileResult.selected.id);
  if (!authoritativeFile) {
    // Defensive — `startBrowserPicker` validates `selected.id` against
    // the option set it was given, so this branch should be unreachable.
    throw new Error("internal: authoritative file selection not found in option set");
  }

  // ------- Resolve drive metadata + folderPath -------

  const drive = await getMyDrive(client, signal);
  const driveId = drive.id;
  const folderPath = derivedFolderPath(folderItem.parentReference?.path, folderItem.name);

  // ------- Generate identifiers + create .collab/ -------

  const projectId = newUlid(() => now().getTime());
  const collabFolder = await createChildFolder(
    client,
    chosenFolderId,
    SENTINEL_FOLDER_NAME,
    signal,
  );

  // ------- Write sentinel -------

  const sentinelDoc: ProjectSentinel = {
    schemaVersion: SENTINEL_SCHEMA_VERSION,
    projectId,
    authoritativeFileId: authoritativeFile.id,
    authoritativeFileName: authoritativeFile.name,
    createdBy: { displayName: createdByDisplayName },
    createdAt: toIsoOffset(now()),
  };
  const sentinelItem = await writeSentinel(
    client,
    // The `.collab/` folder id was just minted by `createChildFolder`
    // (a Graph round-trip whose response is Zod-validated). Re-validate
    // here so the value is brand-typed before it threads into the
    // sentinel write — defence in depth against a future schema change
    // that lets a malformed id through.
    validateGraphId("collabFolder.id", collabFolder.id),
    sentinelDoc,
    signal,
  );

  // ------- Record local metadata + recents -------

  const sentinelCTag = sentinelItem.cTag ?? "";
  if (sentinelCTag.length === 0) {
    // OneDrive always returns a cTag on writes — treat absence as a
    // server bug rather than silently storing an empty pin (which
    // would fail Zod validation downstream anyway).
    throw new Error("Graph response did not include a cTag for the new sentinel");
  }
  const nowIso = toIsoOffset(now());
  const metadata: ProjectMetadata = {
    schemaVersion: 1,
    projectId,
    folderId: chosenFolderId,
    folderPath,
    driveId,
    pinnedAuthoritativeFileId: authoritativeFile.id,
    pinnedSentinelFirstSeenAt: nowIso,
    pinnedAtFirstSeenCTag: sentinelCTag,
    displayAuthoritativeFileName: authoritativeFile.name,
    docId: null,
    addedAt: nowIso,
    lastSeenSentinelAt: nowIso,
    lastSeenAuthoritativeCTag: null,
    lastSeenAuthoritativeRevision: null,
    perAgent: {},
  };
  await saveProjectMetadata(config.configDir, metadata, signal);

  const recent: RecentEntry = {
    projectId,
    folderId: chosenFolderId,
    folderPath,
    authoritativeFile: authoritativeFile.name,
    lastOpened: nowIso,
    role: "originator",
    available: true,
    unavailableReason: null,
  };
  await upsertRecent(config.configDir, recent, signal);

  // ------- Activate the in-memory session (W1 Day 5) -------
  //
  // Per `docs/plans/collab-v1.md` §2.2 the session is bound to this MCP
  // server's OS process. The registry refuses (`SessionAlreadyActiveError`)
  // when one is already active so the agent must end the existing session
  // before starting a new one. Defaults for TTL / write budget /
  // destructive budget come from §5.2.1 — the full slider form lands in
  // a later milestone (the W1 Day 4 init UI only collects folder + file).
  //
  // `clientSlug` is hard-coded to `"unknown"` until W5 Day 3 ("agentId
  // fallback") plumbs MCP `clientInfo.name` through the SDK; the resulting
  // `agentId` still uniquely identifies this session via its `sessionId`
  // suffix.
  const sessionSnapshot = await config.sessionRegistry.start(
    {
      projectId,
      userOid: account.userOid,
      clientSlug: "unknown",
      folderPath,
      authoritativeFileName: authoritativeFile.name,
    },
    signal,
  );

  // §3.6 audit: record `session_start` so post-hoc review can correlate
  // budget / TTL settings with the agent that initialised the project.
  // Best-effort — the writer swallows failures and never fails the tool.
  await writeAudit(
    config,
    {
      sessionId: sessionSnapshot.sessionId,
      agentId: sessionSnapshot.agentId,
      userOid: sessionSnapshot.userOid,
      projectId: sessionSnapshot.projectId,
      tool: "session_init_project",
      result: AuditResult.Success,
      type: "session_start",
      details: {
        ttlSeconds: sessionSnapshot.ttlSeconds,
        writeBudget: sessionSnapshot.writeBudgetTotal,
        destructiveBudget: sessionSnapshot.destructiveBudgetTotal,
        clientName: null,
        clientVersion: null,
      },
    },
    signal,
  );

  // ------- Render success -------

  const opening = renderOpeningMessage({
    folderOpened: browserOpened,
    folderUrl: handle.url,
    fileOpened: fileBrowserOpened,
    fileUrl: fileHandle.url,
  });

  return {
    content: [
      {
        type: "text",
        text:
          `${opening}\n\n` +
          `Project initialised.\n` +
          `  projectId: ${projectId}\n` +
          `  folderPath: ${folderPath}\n` +
          `  authoritativeFile: ${authoritativeFile.name} (${authoritativeFile.id})\n` +
          `  sentinel: ${SENTINEL_FOLDER_NAME}/project.json (cTag ${sentinelCTag})\n\n` +
          `Session active.\n` +
          `  sessionId: ${sessionSnapshot.sessionId}\n` +
          `  agentId: ${sessionSnapshot.agentId}\n` +
          `  ttlSeconds: ${sessionSnapshot.ttlSeconds}\n` +
          `  writeBudget: ${sessionSnapshot.writeBudgetTotal}\n` +
          `  destructiveBudget: ${sessionSnapshot.destructiveBudgetTotal}\n\n` +
          "Local pin recorded — subsequent opens will detect a tampered sentinel.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// session_status
// ---------------------------------------------------------------------------

/**
 * Render the active session as a human-readable text envelope. Per §2.2
 * `session_status`, an expired session is reported as `expired: true`
 * (rather than `isError: true`) with the counters frozen so the agent
 * can call `session_renew` without first calling another tool.
 *
 * As of W3 Day 4 this also surfaces the current leases-sidecar `cTag`
 * so agents have everything `collab_acquire_section` /
 * `collab_release_section` need without a separate read (per §3.2.1).
 * The lookup is best-effort: any Graph failure is logged and reported
 * as `(unavailable)` so a single transient blip never breaks the
 * read-only happy path.
 */
async function runSessionStatus(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<{
  content: { type: "text"; text: string }[];
}> {
  const snap = config.sessionRegistry.snapshot();
  if (snap === null) {
    throw new NoActiveSessionError();
  }
  const expired = config.sessionRegistry.isExpired();
  const secondsRemaining = expired ? 0 : config.sessionRegistry.secondsRemaining();
  const leasesCTag = await readLeasesCTagBestEffort(config, snap.projectId, signal);

  const lines: string[] = [];
  lines.push(`Collab session: ${expired ? "expired" : "active"}`);
  lines.push(`  projectId: ${snap.projectId}`);
  lines.push(`  agentId: ${snap.agentId}`);
  lines.push(`  userOid: ...${userOidSuffix(snap.userOid)}`);
  lines.push(`  folderPath: ${snap.folderPath}`);
  lines.push(`  authoritativeFile: ${snap.authoritativeFileName}`);
  lines.push(`  startedAt: ${snap.startedAt}`);
  lines.push(`  expiresAt: ${snap.expiresAt}`);
  lines.push(`  secondsRemaining: ${secondsRemaining}`);
  lines.push(`  expired: ${expired ? "true" : "false"}`);
  lines.push(`  writes: ${snap.writesUsed} / ${snap.writeBudgetTotal}`);
  lines.push(`  destructive approvals: ${snap.destructiveUsed} / ${snap.destructiveBudgetTotal}`);
  lines.push(`  renewals (this session): ${snap.renewalsUsed} / 3`);
  lines.push(
    `  source counters: chat=${snap.sourceCounters.chat} ` +
      `project=${snap.sourceCounters.project} ` +
      `external=${snap.sourceCounters.external}`,
  );
  lines.push(`  leasesCTag: ${leasesCTag}`);
  if (expired) {
    lines.push("");
    lines.push("Session is past its TTL. Use session_renew to reset the clock.");
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

/**
 * Best-effort fetch of the leases-sidecar `cTag` for the active
 * project. Returns one of:
 *
 *   - the live `cTag` when the sidecar exists,
 *   - `"(none)"` when the sidecar has not been lazy-created yet
 *     (`LeasesFileMissingError`),
 *   - `"(unavailable)"` for any other failure (logged at `warn`).
 *
 * The metadata lookup uses the local pin block so we never depend on
 * the sentinel being readable to surface the cTag — a tampered project
 * still gets a useful status line.
 */
async function readLeasesCTagBestEffort(
  config: ServerConfig,
  projectId: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const metadata = await loadProjectMetadata(config.configDir, projectId, signal);
    if (metadata === null) return "(no project metadata)";
    const projectFolderId = validateGraphId("projectFolderId", metadata.folderId);
    const { item } = await readLeases(config.graphClient, projectFolderId, signal);
    return item.cTag ?? "(unknown)";
  } catch (err: unknown) {
    if (err instanceof LeasesFileMissingError) return "(none)";
    logger.warn("session_status: leases cTag lookup failed (best-effort)", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "(unavailable)";
  }
}

/**
 * Last 8 chars of an Entra `oid` UUID (with hyphens stripped) — only
 * surfaced in `session_status` output to keep that text grep-friendly
 * while reminding operators the full id lives in the audit log.
 */
function userOidSuffix(userOid: string): string {
  const flat = userOid.replace(/-/g, "");
  return flat.length <= 8 ? flat : flat.slice(-8);
}

/**
 * Compose the human-facing "we opened these browser windows for you"
 * preamble. Reports the folder picker and (W1 Day 4) the file picker
 * separately so the human knows which URLs to visit if the auto-open
 * fell back.
 */
function renderOpeningMessage(args: {
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Convert a `Date` to an ISO 8601 string with an explicit UTC offset
 * (`...Z`). The `ProjectMetadata` schema requires `offset: true` so a
 * naked `toISOString()` (which already emits `Z`, an offset) is fine —
 * this wrapper exists so future test environments that replace `now`
 * with a non-UTC clock get a consistent shape.
 */
function toIsoOffset(d: Date): string {
  return d.toISOString();
}

/**
 * Build a user-facing folder path from the parent reference returned by
 * Graph (`/drive/root:` or `/drive/root:/<parent>/<grand-parent>`) plus
 * the folder's own name. Returns `/<folderName>` when the parent path
 * cannot be parsed so we always have a non-empty value to record.
 */
function derivedFolderPath(parentPath: string | undefined, folderName: string): string {
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
