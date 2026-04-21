// `session_init_project` runner. Split out from `./session.ts`.

import {
  AuthenticationRequiredError,
  NoMarkdownFileError,
  ProjectAlreadyInitialisedError,
} from "../errors.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import { startBrowserPicker } from "../picker.js";
import { validateGraphId } from "../graph/ids.js";
import { getMyDrive, listRootFolders } from "../graph/markdown.js";

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
  upsertRecent,
  type ProjectMetadata,
  type RecentEntry,
} from "../collab/projects.js";
import { newUlid } from "../collab/ulid.js";
import { writeAudit, AuditResult } from "../collab/audit.js";
import { SessionAlreadyActiveError } from "../collab/session.js";

import { nowFactory } from "./shared.js";
import {
  derivedFolderPath,
  emitAgentNameUnknownIfNeeded,
  renderOpeningMessage,
  toIsoOffset,
} from "./session-helpers.js";

/**
 * Drive the originator init flow: pick a folder, validate it, write the
 * sentinel + pin block + recents. Throws on every error path so the
 * tool registration above can render them through `formatError`.
 */
export async function runInitProject(
  config: ServerConfig,
  slot: { setUrl: (url: string) => void },
  signal: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const client = config.graphClient;
  const now = nowFactory(config);

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
      ...(config.agentPersona !== undefined ? { agentPersonaId: config.agentPersona.id } : {}),
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
        ...(config.agentPersona !== undefined
          ? {
              mode: "test-persona" as const,
              agentPersona: { id: config.agentPersona.id, source: "env" as const },
            }
          : {}),
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
