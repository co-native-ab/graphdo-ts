// MCP tools for managing a collab v1 session lifecycle:
//
//   - `session_init_project` (W1 Day 3) — originator flow.
//   - `session_open_project` (W4 Day 4) — collaborator flow.
//   - `session_status`, `session_renew`, `session_recover_doc_id` — later
//     milestones. Empty placeholders are NOT registered here — each
//     tool is added in the milestone that ships its DoD.
//
// The W1 Day 3 happy path covers single-`.md` folders only. Multi-md
// resolution lands in W1 Day 4 (`16-multiple-root-md.test.ts`); for
// now, a folder with more than one root `.md` file returns the same
// `NoMarkdownFileError` as the zero-`.md` case but with the count in the
// message so the human can see why.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getMyDrive } from "../graph/markdown.js";
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
  upsertRecent,
  type ProjectMetadata,
  type RecentEntry,
} from "../collab/projects.js";
import { newUlid } from "../collab/ulid.js";
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
    "selects the OneDrive folder and (when the folder contains more than one " +
    "markdown file at the root) the authoritative markdown file. All " +
    "parameters come from that form, not from this tool call. Writes a " +
    ".collab/project.json sentinel into the chosen folder, records the " +
    "project locally, and adds a recents entry. Returns the resulting " +
    "projectId, folder path, and authoritative file name. Use " +
    "session_open_project to join an existing project as a collaborator.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const SESSION_TOOL_DEFS: readonly ToolDef[] = [SESSION_INIT_DEF];

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
  const chosenFolderId = result.selected.id;

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

  // W1 Day 3 — single-md happy path. Multi-md resolution lands in W1 Day 4
  // via the `16-multiple-root-md.test.ts` form. Until then, treat both the
  // zero-md and the multi-md case as a hard error so the agent does not
  // silently pick the wrong file.
  if (markdownFiles.length !== 1) {
    if (markdownFiles.length === 0) {
      throw new NoMarkdownFileError(folderItem.name, chosenFolderId);
    }
    throw new NoMarkdownFileError(
      `${folderItem.name} (found ${String(markdownFiles.length)} root .md files; multi-file selection lands in a future version)`,
      chosenFolderId,
    );
  }
  const authoritativeFile = markdownFiles[0];
  if (!authoritativeFile) {
    // Defensive — `length === 1` already ensures non-undefined, but
    // typescript's `noUncheckedIndexedAccess` makes the explicit guard
    // necessary.
    throw new Error("internal: markdown file list mismatch");
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
  const sentinelItem = await writeSentinel(client, collabFolder.id, sentinelDoc, signal);

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

  // ------- Render success -------

  const opening = browserOpened
    ? "A browser window opened so you could pick the project folder."
    : `Browser auto-open failed; you visited ${handle.url} manually.`;

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
          "Local pin recorded — subsequent opens will detect a tampered sentinel.",
      },
    ],
  };
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
