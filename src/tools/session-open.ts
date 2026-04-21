// `session_open_project` runner. Split out from `./session.ts`.

import {
  AuthenticationRequiredError,
  AuthoritativeFileMissingError,
  NoWriteAccessError,
  NotAFolderError,
  SchemaVersionUnsupportedError,
  SentinelTamperedError,
  StaleRecentError,
} from "../errors.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import { startBrowserPicker } from "../picker.js";
import { validateGraphId } from "../graph/ids.js";

import {
  readSentinel,
  SentinelMissingError,
  verifySentinelAgainstPin,
  type ProjectSentinel,
  type SentinelPin,
} from "../collab/sentinel.js";
import { getDriveItem, getDriveItemPermissions, refreshFolderMetadata } from "../collab/graph.js";
import {
  loadProjectMetadata,
  loadRecents,
  saveProjectMetadata,
  upsertRecent,
  type ProjectMetadata,
  type RecentEntry,
} from "../collab/projects.js";
import { writeAudit, AuditResult } from "../collab/audit.js";
import { SessionAlreadyActiveError, type SessionStartInput } from "../collab/session.js";

import { nowFactory } from "./shared.js";
import { derivedFolderPath, emitAgentNameUnknownIfNeeded, toIsoOffset } from "./session-helpers.js";

export async function runOpenProject(
  config: ServerConfig,
  slot: { setUrl: (url: string) => void },
  signal: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const client = config.graphClient;
  const now = nowFactory(config);

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
    ...(config.agentPersona !== undefined ? { agentPersonaId: config.agentPersona.id } : {}),
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
