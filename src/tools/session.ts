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
  StaleRecentError,
  AuthoritativeFileMissingError,
  NotAFolderError,
  NoWriteAccessError,
  SchemaVersionUnsupportedError,
  DocIdAlreadyKnownError,
  DocIdUnrecoverableError,
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
  readSentinel,
  verifySentinelAgainstPin,
  SentinelMissingError,
  type ProjectSentinel,
  type SentinelPin,
} from "../collab/sentinel.js";
import {
  createChildFolder,
  findChildFolderByName,
  getDriveItem,
  listRootMarkdownFiles,
  getDriveItemPermissions,
  refreshFolderMetadata,
} from "../collab/graph.js";
import {
  saveProjectMetadata,
  loadProjectMetadata,
  upsertRecent,
  loadRecents,
  type ProjectMetadata,
  type RecentEntry,
} from "../collab/projects.js";
import { walkVersionsForDocId, MAX_RECOVERY_VERSIONS } from "../collab/doc-id-recovery.js";
import { readMarkdownFrontmatter } from "../collab/frontmatter.js";
import { downloadMarkdownContent } from "../graph/markdown.js";
import {
  NoActiveSessionError,
  SessionAlreadyActiveError,
  MAX_RENEWALS_PER_SESSION,
  type SessionStartInput,
} from "../collab/session.js";
import { newUlid } from "../collab/ulid.js";
import { writeAudit, AuditResult } from "../collab/audit.js";
import { LeasesFileMissingError, readLeases } from "../collab/leases.js";
import {
  recordRenewal,
  renewalKey,
  windowCount,
  MAX_RENEWALS_PER_WINDOW,
  RENEWAL_WINDOW_MS,
} from "../collab/renewal-counts.js";
import { listRootFolders } from "../graph/markdown.js";
import {
  SentinelTamperedError,
  RenewalCapPerSessionError,
  RenewalCapPerWindowError,
  BrowserFormCancelledError,
} from "../errors.js";

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

const SESSION_OPEN_DEF: ToolDef = {
  name: "session_open_project",
  title: "Open Collaboration Project",
  description:
    "Join an existing collaboration project as a collaborator. Opens a browser form " +
    "with three entry points: recents (previously opened projects), 'shared with me' " +
    "(folders shared with your OneDrive account), and a URL paste box for OneDrive share links. " +
    "All parameters come from the form. Reads the .collab/project.json sentinel, validates " +
    "write access, activates a session, and writes a session_start audit entry. Returns the " +
    "project details similar to session_init_project. Use session_init_project to create a " +
    "new project as the originator.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

const SESSION_RENEW_DEF: ToolDef = {
  name: "session_renew",
  title: "Renew Collab Session",
  description:
    "Reset the active collaboration session's TTL clock by opening a browser " +
    "approval form. Counters are persisted across the renewal: writes used, " +
    "destructive approvals used, and source counters are preserved. Caps: " +
    "max 3 renewals per session and max 6 renewals per user per project per " +
    "rolling 24-hour window. On approval, the session's expiresAt is reset " +
    "to now + the original TTL, the renewal counters increment, and a renewal " +
    "audit entry is written. Errors with RenewalCapPerSessionError or " +
    "RenewalCapPerWindowError when the relevant cap is reached.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

const SESSION_RECOVER_DOC_ID_DEF: ToolDef = {
  name: "session_recover_doc_id",
  title: "Recover Document ID",
  description:
    "Recover the project's `doc_id` when both the live frontmatter and the " +
    "local project metadata cache are gone (a fresh machine and a cooperator " +
    "wiped the YAML envelope in OneDrive web). Walks the authoritative file's " +
    "`/versions` history newest-first, capped at 50 versions, and writes the " +
    "first recoverable `doc_id` back to the local cache. No body change, no " +
    "restoreVersion call, no destructive-budget cost, no write-budget cost. " +
    "When live frontmatter parses cleanly and the local cache already holds a " +
    "matching `docId`, this tool is a no-op (returns informational message, " +
    "not an error). When no historical version yields a parseable `doc_id`, " +
    "errors with DocIdUnrecoverableError.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const SESSION_TOOL_DEFS: readonly ToolDef[] = [
  SESSION_INIT_DEF,
  SESSION_STATUS_DEF,
  SESSION_OPEN_DEF,
  SESSION_RENEW_DEF,
  SESSION_RECOVER_DOC_ID_DEF,
];

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
    defineTool(
      server,
      SESSION_OPEN_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_OPEN_DEF.title,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (_args, { signal }) => {
        const slot = acquireFormSlot("session_open_project");
        try {
          return await runOpenProject(config, slot, signal);
        } catch (err: unknown) {
          if (err instanceof UserCancelledError) {
            return {
              content: [{ type: "text", text: "Project open cancelled." }],
            };
          }
          const isTimeout = err instanceof Error && err.message.toLowerCase().includes("timed out");
          const retryHint = isTimeout
            ? "\n\nThe user did not make a selection in time. " +
              "You can call this tool again if the user would like to retry."
            : "\n\nYou can call this tool again if the user would like to retry.";
          return formatError("session_open_project", err, { suffix: retryHint });
        } finally {
          slot.release();
        }
      },
    ),
    defineTool(
      server,
      SESSION_RENEW_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_RENEW_DEF.title,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (_args, { signal }) => {
        try {
          if (signal.aborted) throw signal.reason;
          return await runSessionRenew(config, signal);
        } catch (err: unknown) {
          if (err instanceof UserCancelledError || err instanceof BrowserFormCancelledError) {
            return {
              content: [
                {
                  type: "text",
                  text: "Session renewal cancelled. The TTL clock was not reset.",
                },
              ],
            };
          }
          return formatError("session_renew", err);
        }
      },
    ),
    defineTool(
      server,
      SESSION_RECOVER_DOC_ID_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_RECOVER_DOC_ID_DEF.title,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (_args, { signal }) => {
        try {
          if (signal.aborted) throw signal.reason;
          return await runSessionRecoverDocId(config, signal);
        } catch (err: unknown) {
          if (err instanceof DocIdAlreadyKnownError) {
            // Informational, not isError per §2.2.
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Nothing to recover.\n  doc_id: ${err.docId}\n` +
                    "Both the live frontmatter and the local project metadata " +
                    "already have a matching doc_id; no version walk was needed.",
                },
              ],
            };
          }
          return formatError("session_recover_doc_id", err);
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
  // `clientName` / `clientVersion` are read from `config.getClientInfo()`
  // (W5 Day 3); the registry slugifies the name into the middle segment
  // of `agentId` and falls back to `"unknown"` when the value is absent
  // / non-slug. The fallback path arms a per-session warn-once
  // `agent_name_unknown` audit emitted just below.
  const clientInfo = config.getClientInfo?.();
  const clientName = clientInfo?.name ?? null;
  const clientVersion = clientInfo?.version ?? null;
  const sessionSnapshot = await config.sessionRegistry.start(
    {
      projectId,
      userOid: account.userOid,
      clientName,
      clientVersion,
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
        clientName,
        clientVersion,
      },
    },
    signal,
  );

  // §3.6 / §10 question 4 — warn-once `agent_name_unknown` audit. Fires
  // when the resolved agentId middle segment is the literal `"unknown"`
  // (i.e. `clientInfo.name` was missing or all-non-slug-chars). The
  // registry's tryMark helper guarantees at-most-once-per-session.
  await emitAgentNameUnknownIfNeeded(config, sessionSnapshot, clientInfo, signal);

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
async function emitAgentNameUnknownIfNeeded(
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

// ---------------------------------------------------------------------------
// W4 Day 4 — session_open_project
// ---------------------------------------------------------------------------

/**
 * Open an existing collab project as a collaborator. For W4 Day 4 this is
 * implemented with a stub form mechanism that tests can drive directly.
 * The full three-panel browser form (recents / shared-with-me / URL paste)
 * will be added in a follow-up.
 */
async function runOpenProject(
  config: ServerConfig,
  slot: { setUrl: (url: string) => void },
  signal: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const client = config.graphClient;
  const now = config.now ?? ((): Date => new Date());

  // Refuse early if a session is already active
  const existing = config.sessionRegistry.snapshot();
  if (existing !== null) {
    throw new SessionAlreadyActiveError(existing.projectId);
  }

  const account = await config.authenticator.accountInfo(signal);
  if (!account) {
    throw new AuthenticationRequiredError();
  }

  // For W4 Day 4, we use a simple stub mechanism. Integration tests will
  // inject a (driveId, folderId) pair directly via a custom picker spy.
  // The full browser form lands in a follow-up milestone.
  const recents = await loadRecents(config.configDir, signal);
  const recentsOptions = recents.entries
    .filter((e) => e.available)
    .map((e) => ({
      id: `recent:${e.projectId}:${e.folderId}`,
      label: `${e.folderPath} — ${e.authoritativeFile}`,
      meta: { projectId: e.projectId, folderId: e.folderId },
    }));

  const handle = await startBrowserPicker(
    {
      title: "Open Collab Project",
      subtitle:
        "Select a project from your recents, or use the test stub to pass a folder ID directly.",
      options: recentsOptions,
      filterPlaceholder: "Filter projects...",
      onSelect: async () => {
        // Work happens after picker resolves
      },
    },
    signal,
  );
  slot.setUrl(handle.url);

  try {
    await config.openBrowser(handle.url);
    logger.info("session_open_project picker opened", { url: handle.url });
  } catch (err: unknown) {
    logger.warn("could not open browser for session_open_project", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const result = await handle.waitForSelection;
  const selectedId = result.selected.id;

  // Parse the selection. For now we support "recent:..." and direct folder IDs (test stub).
  let folderId: string;
  let projectIdHint: string | null = null;
  let isRecentEntry = false;

  if (selectedId.startsWith("recent:")) {
    const parts = selectedId.split(":");
    if (parts.length !== 3) {
      throw new Error(`Malformed recent selection: ${selectedId}`);
    }
    projectIdHint = parts[1] ?? null;
    folderId = parts[2] ?? "";
    isRecentEntry = true;
  } else {
    // Direct folder ID (test stub path)
    folderId = selectedId;
  }

  const chosenFolderId = validateGraphId("chosenFolderId", folderId);

  // Read sentinel
  let sentinelData: { sentinel: ProjectSentinel; item: { cTag?: string } };
  try {
    sentinelData = await readSentinel(client, chosenFolderId, signal);
  } catch (err) {
    if (err instanceof SentinelMissingError && isRecentEntry && projectIdHint) {
      // Mark recent unavailable
      const recentEntry = recents.entries.find((e) => e.projectId === projectIdHint);
      if (recentEntry) {
        await upsertRecent(
          config.configDir,
          { ...recentEntry, available: false, unavailableReason: "folder_missing" },
          signal,
        );
      }
      throw new StaleRecentError(projectIdHint, chosenFolderId);
    }
    throw err;
  }

  const sentinel = sentinelData.sentinel;

  // Sniff schema version before strict parse
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (sentinel.schemaVersion > 1) {
    throw new SchemaVersionUnsupportedError(sentinel.schemaVersion);
  }

  // Look up authoritative file
  let authoritativeFileItem;
  try {
    authoritativeFileItem = await getDriveItem(
      client,
      validateGraphId("authoritativeFileId", sentinel.authoritativeFileId),
      signal,
    );
  } catch {
    throw new AuthoritativeFileMissingError(sentinel.authoritativeFileId);
  }

  // Confirm folder is a folder
  const folderItem = await getDriveItem(client, chosenFolderId, signal);
  if (folderItem.folder === undefined) {
    throw new NotAFolderError(chosenFolderId);
  }

  // Check write permission
  // Validate `driveId` before splicing into a Graph URL (ADR-0007).
  // `parentReference?.driveId` is response data — Zod confirms it is a
  // string, but we re-validate to defend against a buggy mock or a
  // future Graph response shape change leaking an empty / malformed id.
  const driveId = validateGraphId("driveId", folderItem.parentReference?.driveId ?? "");
  const permissions = await getDriveItemPermissions(client, driveId, chosenFolderId, signal);
  const hasWrite = permissions.some((p) => p.roles?.some((r) => r === "write" || r === "owner"));
  if (!hasWrite) {
    throw new NoWriteAccessError(chosenFolderId);
  }

  // Determine first vs subsequent open
  const existingMetadata = await loadProjectMetadata(config.configDir, sentinel.projectId, signal);

  if (existingMetadata === null) {
    // First open — write pin block
    const nowIso = toIsoOffset(now());
    const metadata: ProjectMetadata = {
      schemaVersion: 1,
      projectId: sentinel.projectId,
      folderId: chosenFolderId,
      folderPath: derivedFolderPath(folderItem.parentReference?.path, folderItem.name),
      driveId,
      pinnedAuthoritativeFileId: sentinel.authoritativeFileId,
      pinnedSentinelFirstSeenAt: nowIso,
      pinnedAtFirstSeenCTag: sentinelData.item.cTag ?? "",
      displayAuthoritativeFileName: sentinel.authoritativeFileName,
      docId: null,
      addedAt: nowIso,
      lastSeenSentinelAt: nowIso,
      lastSeenAuthoritativeCTag: authoritativeFileItem.cTag ?? null,
      lastSeenAuthoritativeRevision: authoritativeFileItem.version ?? null,
      perAgent: {},
    };
    await saveProjectMetadata(config.configDir, metadata, signal);
  } else {
    // Subsequent open — verify sentinel against pin
    const pin: SentinelPin = {
      pinnedAuthoritativeFileId: existingMetadata.pinnedAuthoritativeFileId,
      pinnedSentinelFirstSeenAt: existingMetadata.pinnedSentinelFirstSeenAt,
      pinnedAtFirstSeenCTag: existingMetadata.pinnedAtFirstSeenCTag,
      displayAuthoritativeFileName: existingMetadata.displayAuthoritativeFileName,
    };

    try {
      const verifyResult = verifySentinelAgainstPin(sentinel, pin);
      if (verifyResult.kind === "renamed") {
        // Silent refresh of display name
        await saveProjectMetadata(
          config.configDir,
          {
            ...existingMetadata,
            displayAuthoritativeFileName: verifyResult.refreshedDisplayAuthoritativeFileName,
          },
          signal,
        );
      }
    } catch (err: unknown) {
      if (err instanceof SentinelTamperedError) {
        // Write audit entry before throwing
        await writeAudit(
          config,
          {
            sessionId: "",
            agentId: "",
            userOid: account.userOid,
            projectId: sentinel.projectId,
            tool: "session_open_project",
            result: AuditResult.Failure,
            type: "sentinel_changed",
            details: {
              pinnedAuthoritativeFileId: err.pinnedAuthoritativeFileId,
              currentAuthoritativeFileId: err.currentAuthoritativeFileId,
              pinnedAtFirstSeenCTag: existingMetadata.pinnedAtFirstSeenCTag,
              currentSentinelCTag: sentinelData.item.cTag ?? "",
            },
          },
          signal,
        );
      }
      throw err;
    }
  }

  // Silent folder-path refresh
  const refreshed = await refreshFolderMetadata(client, driveId, chosenFolderId, signal);
  const updatedMetadata = await loadProjectMetadata(config.configDir, sentinel.projectId, signal);
  if (updatedMetadata) {
    await saveProjectMetadata(
      config.configDir,
      { ...updatedMetadata, folderPath: refreshed.folderPath },
      signal,
    );
  }

  // Upsert recent
  const recentEntry: RecentEntry = {
    projectId: sentinel.projectId,
    folderId: chosenFolderId,
    folderPath: refreshed.folderPath,
    authoritativeFile: sentinel.authoritativeFileName,
    lastOpened: toIsoOffset(now()),
    available: true,
    unavailableReason: null,
    role: "collaborator",
  };
  await upsertRecent(config.configDir, recentEntry, signal);

  // Activate session — clientInfo plumbed via config.getClientInfo (W5
  // Day 3). Missing/unknown name falls back to slug `"unknown"` and arms
  // the per-session warn-once `agent_name_unknown` audit emitted below.
  const clientInfo = config.getClientInfo?.();
  const clientName = clientInfo?.name ?? null;
  const clientVersion = clientInfo?.version ?? null;
  const sessionInput: SessionStartInput = {
    projectId: sentinel.projectId,
    userOid: account.userOid,
    clientName,
    clientVersion,
    folderPath: refreshed.folderPath,
    authoritativeFileName: sentinel.authoritativeFileName,
  } as const;
  const session = await config.sessionRegistry.start(sessionInput, signal);

  // Write audit
  await writeAudit(
    config,
    {
      sessionId: session.sessionId,
      agentId: session.agentId,
      userOid: account.userOid,
      projectId: sentinel.projectId,
      tool: "session_open_project",
      result: AuditResult.Success,
      type: "session_start",
      details: {
        ttlSeconds: session.ttlSeconds,
        writeBudget: session.writeBudgetTotal,
        destructiveBudget: session.destructiveBudgetTotal,
        clientName,
        clientVersion,
      },
    },
    signal,
  );

  await emitAgentNameUnknownIfNeeded(config, session, clientInfo, signal);

  return {
    content: [
      {
        type: "text",
        text: `Collab session opened successfully.\n\nProject: ${sentinel.projectId}\nFolder: ${refreshed.folderPath}\nAuthoritative file: ${sentinel.authoritativeFileName}\nRole: collaborator\nAgent ID: ${session.agentId}\nSession expires: ${session.expiresAt}\nWrite budget: ${String(session.writeBudgetTotal)}\nDestructive budget: ${String(session.destructiveBudgetTotal)}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// W4 Day 5 — session_renew
// ---------------------------------------------------------------------------

/**
 * Drive the §2.2 `session_renew` flow:
 *
 *   1. Require an active session in this MCP instance.
 *   2. Pre-check the per-session cap (`MAX_RENEWALS_PER_SESSION = 3` —
 *      from the in-memory snapshot).
 *   3. Pre-check the per-window cap (`MAX_RENEWALS_PER_WINDOW = 6` per
 *      `(userOid, projectId)` per rolling 24h — read from disk via
 *      `windowCount`).
 *   4. Open a browser approval form via the W0 form-factory slot.
 *   5. On approve: append the renewal timestamp to the sliding window,
 *      reset `expiresAt` via `sessionRegistry.renew()`, and emit a
 *      `renewal` audit envelope (best-effort).
 *
 * The pre-checks raise *before* opening the browser so a budget-exhausted
 * agent never spawns a re-prompt the human would just have to cancel.
 * On cancel / timeout the registry is untouched and no entry is written
 * to the renewal-counts sidecar.
 */
async function runSessionRenew(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const now = config.now ?? ((): Date => new Date());

  const snap = config.sessionRegistry.snapshot();
  if (snap === null) {
    throw new NoActiveSessionError();
  }

  // Pre-check the per-session cap. The registry's `renew()` itself does
  // not enforce this — keeping the policy in the tool layer keeps
  // counters and forms aligned (we never open a form we are about to
  // refuse anyway).
  if (snap.renewalsUsed >= MAX_RENEWALS_PER_SESSION) {
    throw new RenewalCapPerSessionError(snap.renewalsUsed, MAX_RENEWALS_PER_SESSION);
  }

  // Pre-check the per-window cap. The sliding window is keyed by
  // `(userOid, projectId)` per §3.5 — `loadRenewalCounts` prunes entries
  // older than 24h on read so a stale row never blocks a fresh renewal.
  const key = renewalKey(snap.userOid, snap.projectId);
  const beforeCount = await windowCount(config.configDir, key, now(), signal);
  if (beforeCount >= MAX_RENEWALS_PER_WINDOW) {
    throw new RenewalCapPerWindowError(
      beforeCount,
      MAX_RENEWALS_PER_WINDOW,
      RENEWAL_WINDOW_MS / (60 * 60 * 1000),
    );
  }

  // Open the §5.2 re-approval form via the W0 form-factory slot.
  const slot = acquireFormSlot("session_renew");
  try {
    const summaryLines = [
      `projectId: ${snap.projectId}`,
      `folderPath: ${snap.folderPath}`,
      `currentExpiresAt: ${snap.expiresAt}`,
      `ttlSeconds (will be re-applied on approve): ${snap.ttlSeconds}`,
      `renewals (this session): ${snap.renewalsUsed} / ${MAX_RENEWALS_PER_SESSION}`,
      `renewals (rolling 24h): ${beforeCount} / ${MAX_RENEWALS_PER_WINDOW}`,
      `writes used: ${snap.writesUsed} / ${snap.writeBudgetTotal}`,
      `destructive used: ${snap.destructiveUsed} / ${snap.destructiveBudgetTotal}`,
    ];
    const handle = await startBrowserPicker(
      {
        title: "Approve Session Renewal",
        subtitle:
          "An MCP tool is asking to reset the session TTL clock. Counters " +
          "(writes / destructive / sources) are preserved across the renewal. " +
          "Click Approve to renew, or Cancel to refuse.\n\n" +
          summaryLines.join("\n"),
        options: [{ id: "approve", label: "Approve session renewal" }],
        onSelect: async () => {
          // Counter mutations happen after the picker resolves so the
          // slot URL stays useful in FormBusyError messages until the
          // sidecar write + registry update complete.
        },
      },
      signal,
    );
    slot.setUrl(handle.url);

    let browserOpened = false;
    try {
      await config.openBrowser(handle.url);
      browserOpened = true;
      logger.info("session_renew picker opened", { url: handle.url });
    } catch (err: unknown) {
      logger.warn("could not open browser for session_renew", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!browserOpened) {
      logger.info("session_renew awaiting manual visit", { url: handle.url });
    }

    try {
      await handle.waitForSelection;
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) {
        throw new BrowserFormCancelledError("session_renew");
      }
      throw err;
    }

    // Approved — append to the sliding window, then reset the TTL
    // clock. Order matters: the persisted window entry is the source of
    // truth for the per-user/per-project cap, so writing it first means
    // a crash between the two operations still records the cap usage
    // (rather than letting the agent retry forever for free).
    const recorded = await recordRenewal(config.configDir, key, now(), signal);
    const renewedSnap = await config.sessionRegistry.renew(undefined, signal);

    // §3.6 audit envelope. Best-effort — the writer swallows failures
    // and never fails the tool call.
    await writeAudit(
      config,
      {
        sessionId: renewedSnap.sessionId,
        agentId: renewedSnap.agentId,
        userOid: renewedSnap.userOid,
        projectId: renewedSnap.projectId,
        tool: "session_renew",
        result: AuditResult.Success,
        type: "renewal",
        details: {
          windowCountBefore: recorded.windowCountBefore,
          windowCountAfter: recorded.windowCountAfter,
          sessionRenewalsBefore: snap.renewalsUsed,
          sessionRenewalsAfter: renewedSnap.renewalsUsed,
        },
      },
      signal,
    );

    const lines = [
      "Session renewed.",
      `  sessionId: ${renewedSnap.sessionId}`,
      `  expiresAt: ${renewedSnap.expiresAt}`,
      `  ttlSeconds: ${renewedSnap.ttlSeconds}`,
      `  renewals (this session): ${renewedSnap.renewalsUsed} / ${MAX_RENEWALS_PER_SESSION}`,
      `  renewals (rolling 24h): ${recorded.windowCountAfter} / ${MAX_RENEWALS_PER_WINDOW}`,
      `  writes: ${renewedSnap.writesUsed} / ${renewedSnap.writeBudgetTotal}`,
      `  destructive: ${renewedSnap.destructiveUsed} / ${renewedSnap.destructiveBudgetTotal}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } finally {
    slot.release();
  }
}

// ---------------------------------------------------------------------------
// W5 Day 1 — session_recover_doc_id
// ---------------------------------------------------------------------------

/**
 * Drive the §2.2 `session_recover_doc_id` flow:
 *
 *   1. Require an active, non-expired session.
 *   2. Read live authoritative content + project metadata. When the
 *      live frontmatter parses **and** the local cache holds a
 *      matching `docId`, raise the informational
 *      {@link DocIdAlreadyKnownError} (handler renders it as a non-
 *      isError success).
 *   3. Otherwise walk `/versions` newest-first via
 *      {@link walkVersionsForDocId} (cap 50). On the first hit, persist
 *      the recovered `docId` back to local metadata (atomic via
 *      `saveProjectMetadata`'s temp+rename) and emit a
 *      `doc_id_recovered` audit envelope. No body change. No
 *      `restoreVersion` call. No write- or destructive-budget cost.
 *   4. When the walk exhausts without finding a parseable `doc_id`,
 *      throw {@link DocIdUnrecoverableError} carrying the count of
 *      versions inspected.
 */
async function runSessionRecoverDocId(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const snap = config.sessionRegistry.snapshot();
  if (snap === null) {
    throw new NoActiveSessionError();
  }
  if (config.sessionRegistry.isExpired()) {
    // Mirror the typed error other collab tools surface so the agent
    // gets a uniform "renew first" experience.
    throw new Error(
      "The active collab session has expired. " +
        "Call session_renew to extend the TTL, or start a new session.",
    );
  }

  const metadata = await loadProjectMetadata(config.configDir, snap.projectId, signal);
  if (metadata === null) {
    throw new Error(
      `Project metadata not found for projectId ${snap.projectId}. ` +
        "This is unexpected — the session was started without persisting metadata.",
    );
  }

  const client = config.graphClient;
  const authoritativeItemId = validateGraphId(
    "pinnedAuthoritativeFileId",
    metadata.pinnedAuthoritativeFileId,
  );

  // Read the live content so we can short-circuit the no-op case
  // (live frontmatter parses + cache already has the same docId)
  // before spending any version GETs.
  const liveContent = await downloadMarkdownContent(client, authoritativeItemId, signal);
  const liveRead = readMarkdownFrontmatter(liveContent);
  if (
    liveRead.kind === "parsed" &&
    metadata.docId !== null &&
    metadata.docId === liveRead.frontmatter.collab.doc_id
  ) {
    throw new DocIdAlreadyKnownError(metadata.docId);
  }

  // Walk newest-first looking for a parseable historical version.
  const result = await walkVersionsForDocId(client, authoritativeItemId, signal);
  if (result.kind === "exhausted") {
    throw new DocIdUnrecoverableError(metadata.projectId, result.versionsInspected);
  }

  // Persist the recovered docId. No other field changes — the live
  // file's body, cTag, and revision are untouched.
  await saveProjectMetadata(config.configDir, { ...metadata, docId: result.docId }, signal);

  // §3.6 audit. Best-effort — the writer swallows failures.
  await writeAudit(
    config,
    {
      sessionId: snap.sessionId,
      agentId: snap.agentId,
      userOid: snap.userOid,
      projectId: snap.projectId,
      tool: "session_recover_doc_id",
      result: AuditResult.Success,
      type: "doc_id_recovered",
      details: {
        recoveredFrom: result.recoveredFrom,
        versionsInspected: result.versionsInspected,
      },
    },
    signal,
  );

  const lines = [
    "doc_id recovered.",
    `  doc_id: ${result.docId}`,
    `  recoveredFrom: version ${result.recoveredFrom}`,
    `  versionsInspected: ${result.versionsInspected} (cap ${MAX_RECOVERY_VERSIONS})`,
    "",
    "Local project metadata updated. The next collab_write to the " +
      "authoritative file will re-inject this doc_id into the emitted " +
      "frontmatter envelope.",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
