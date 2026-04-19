// MCP tools for managing a collab v1 session lifecycle:
//
//   - `session_init_project` (W1 Day 3 + W1 Day 4) — originator flow.
//   - `session_open_project` (W4 Day 4) — collaborator flow.
//   - `session_status`, `session_renew`, `session_recover_doc_id` — later
//     milestones. Empty placeholders are NOT registered here — each
//     tool is added in the milestone that ships its DoD.
//
// W1 Day 4 adds multi-root-md handling: after the folder picker resolves,
// a second browser picker is opened to let the human pick the
// authoritative `.md` file. This picker is shown for every folder with
// ≥1 root `.md` files (including the N=1 case, where it pre-selects the
// only option for confirmation). A folder with zero root `.md` files
// continues to throw `NoMarkdownFileError`. Both pickers share the
// W0 form-factory slot, so concurrent tools always see the URL of the
// page the human is currently looking at in `FormBusyError`.

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
          "Local pin recorded — subsequent opens will detect a tampered sentinel.",
      },
    ],
  };
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
