// Static {@link ToolDef} entries for the markdown tool family.
// Split out from `./markdown.ts`; re-exported through the barrel.

import { GraphScope } from "../scopes.js";
import { MARKDOWN_FILE_NAME_RULES } from "../graph/markdown.js";
import type { ToolDef } from "../tool-registry.js";

const MARKDOWN_SIZE_CAP_NOTE = "graphdo-ts tool-side cap, not a Microsoft Graph API limit";
export { MARKDOWN_SIZE_CAP_NOTE };

export const SELECT_ROOT_DEF: ToolDef = {
  name: "markdown_select_root_folder",
  title: "Select Markdown Root Folder",
  description:
    "Select the root folder that graphdo should use for markdown files in " +
    "the signed-in user's OneDrive. Call this tool directly when a markdown " +
    "root folder has not been configured yet - do not ask the user which " +
    "folder, this tool opens a browser picker where the user makes the " +
    "selection themselves. This is a human-only action - the AI agent cannot " +
    "choose the folder programmatically. Calling it again overwrites the " +
    "stored value.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const LIST_FILES_DEF: ToolDef = {
  name: "markdown_list_files",
  title: "List Markdown Files",
  description:
    "List markdown files directly inside the configured root folder in the " +
    "signed-in user's OneDrive. Each entry reports the file name, opaque " +
    "file ID, last modified timestamp, and size in bytes. Subdirectories " +
    "and files whose names do not follow the strict naming rules are also " +
    "reported, but marked as UNSUPPORTED - these entries exist but cannot " +
    "be read, written, or deleted by the markdown tools. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const GET_FILE_DEF: ToolDef = {
  name: "markdown_get_file",
  title: "Get Markdown File",
  description:
    "Read a markdown file from the signed-in user's OneDrive (the configured " +
    "root folder). Accepts either a file ID (from markdown_list_files) or a " +
    "file name. File names must follow the strict naming rules and are " +
    "rejected otherwise - paths, subdirectories, and characters that are " +
    "not portable across Linux, macOS, and Windows are not allowed. Returns " +
    "the current UTF-8 content of the file along with its cTag (OneDrive's " +
    "content-only entity tag), which markdown_update_file requires for safe " +
    "optimistic concurrency. Files larger than 4 MiB cannot be downloaded " +
    "and will return an error " +
    `(${MARKDOWN_SIZE_CAP_NOTE}). ` +
    "To read a previous version, use markdown_get_file_version. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const CREATE_FILE_DEF: ToolDef = {
  name: "markdown_create_file",
  title: "Create Markdown File",
  description:
    "Create a new markdown file in the configured root folder. Fails with a " +
    "clear error when a file with the same name already exists - in that " +
    "case, call markdown_get_file to fetch the existing content and cTag, " +
    "then call markdown_update_file. The file name must follow the strict " +
    "naming rules - paths, subdirectories, and characters that are not " +
    "portable across Linux, macOS, and Windows are rejected. Payloads " +
    `larger than 4 MiB are rejected (${MARKDOWN_SIZE_CAP_NOTE}). ` +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const EDIT_FILE_DEF: ToolDef = {
  name: "markdown_edit",
  title: "Edit Markdown File",
  description:
    "Apply one or more targeted text substitutions to an existing markdown " +
    "file in the configured root folder, in a single read-modify-write round " +
    "trip under cTag-based optimistic concurrency. Each edit replaces an " +
    "exact byte-for-byte substring (old_string) with another (new_string); " +
    "no whitespace flexibility, no fuzzy matching. By default each old_string " +
    "must match exactly one location in the current file content - if it " +
    "matches zero locations the call fails and asks the agent to extend " +
    "old_string with surrounding context, and if it matches multiple " +
    "locations the call fails and asks the agent to either extend " +
    "old_string until it matches exactly once or set replace_all: true. " +
    "Edits are applied sequentially against the evolving in-memory content " +
    "(edit N sees the result of edits 0..N-1) and are atomic - if any edit " +
    "fails, the entire batch is rejected and nothing is written. Line " +
    "endings are normalised to LF on read, on inputs, and on the persisted " +
    "result. The tool reads the current cTag itself, so the agent does not " +
    "supply one - cTag mismatch only happens when another writer modifies " +
    "the file between this tool's own GET and PUT, in which case the same " +
    "reconcile guidance as markdown_update_file is returned. Set " +
    "dry_run: true to preview the resulting unified diff without writing. " +
    "On success returns a unified diff (tight context) and the new cTag, " +
    `plus a structuredContent mirror for chained edits. Payloads larger ` +
    `than 4 MiB are rejected (${MARKDOWN_SIZE_CAP_NOTE}). ` +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const UPDATE_FILE_DEF: ToolDef = {
  name: "markdown_update_file",
  title: "Update Markdown File",
  description:
    "Overwrite the content of an existing markdown file in the configured " +
    "root folder. Requires the cTag previously returned by markdown_get_file " +
    "(or markdown_create_file / markdown_update_file). The cTag is OneDrive's " +
    "content-only entity tag, so unrelated metadata changes (rename, share, " +
    "indexing, preview generation) do not invalidate it. The update succeeds " +
    "only when the supplied cTag matches the file's current cTag - if the " +
    "file's content has changed since you read it, the call fails with the " +
    "current cTag and modification time. When that happens you must call " +
    "markdown_get_file again to retrieve the latest content + cTag, decide " +
    "whether your intended update still applies, reconcile your changes " +
    "against any new content, and call markdown_update_file again with the " +
    "new cTag - or ask the user how to proceed if the meaning of your " +
    "update no longer fits. Accepts the file by id (preferred) or by name. " +
    `Payloads larger than 4 MiB are rejected (${MARKDOWN_SIZE_CAP_NOTE}). ` +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const DELETE_FILE_DEF: ToolDef = {
  name: "markdown_delete_file",
  title: "Delete Markdown File",
  description:
    "Permanently delete a markdown file from the configured root folder of " +
    "the signed-in user's OneDrive. Accepts either a file ID or a file " +
    "name. File names must follow the strict naming rules and are rejected " +
    "otherwise. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const LIST_VERSIONS_DEF: ToolDef = {
  name: "markdown_list_file_versions",
  title: "List Markdown File Versions",
  description:
    "List historical versions of a markdown file in the signed-in user's " +
    "OneDrive. OneDrive retains previous versions automatically whenever a " +
    "file is overwritten; this tool surfaces that history (newest first) " +
    "so the agent can see when the file changed and, together with " +
    "markdown_get_file_version, recover earlier content. Accepts either a " +
    "file ID or a file name. Returns each version's opaque version ID, " +
    "last modified timestamp, size in bytes, and - when available - the " +
    "name of the user who last modified it. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const GET_VERSION_DEF: ToolDef = {
  name: "markdown_get_file_version",
  title: "Get Markdown File Version",
  description:
    "Read the UTF-8 content of a specific historical version of a markdown " +
    "file in the signed-in user's OneDrive. Requires the file (by ID or " +
    "name) and the version ID previously returned by " +
    "markdown_list_file_versions. This does not restore or modify the file " +
    "- it only reads the prior content. Use markdown_update_file to " +
    "re-upload that content if you want to make it current. Files larger " +
    `than 4 MiB cannot be downloaded (${MARKDOWN_SIZE_CAP_NOTE}). ` +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const DIFF_VERSIONS_DEF: ToolDef = {
  name: "markdown_diff_file_versions",
  title: "Diff Markdown File Versions",
  description:
    "Return a unified diff between two revisions of a markdown file in the " +
    "configured root folder, computed server-side so you do not have to " +
    "diff the content yourself. Accepts the file by id (preferred) or name, " +
    "plus a fromVersionId and a toVersionId. Each ID may be either a " +
    "historical version ID returned by markdown_list_file_versions, or the " +
    "current Revision surfaced by markdown_get_file / markdown_create_file / " +
    "markdown_update_file (including the Current Revision reported in a " +
    "cTag-mismatch error). This is the preferred way to reconcile a stale " +
    "update: pass the revision you originally read as fromVersionId and the " +
    "current revision as toVersionId. Returns a text/x-diff unified patch. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const PREVIEW_FILE_DEF: ToolDef = {
  name: "markdown_preview_file",
  title: "Preview Markdown File in Browser",
  description:
    "Open a markdown file from the configured root folder in the user's " +
    "browser using the SharePoint OneDrive web preview, which renders the " +
    "markdown nicely instead of triggering a download. Accepts the file " +
    "name only (the preview URL is human-facing, so the agent should look " +
    "the file up by name the same way a user would refer to it). The tool " +
    "opens the URL in the default browser via the configured browser " +
    "launcher and also returns the URL as text so it can be shared. " +
    "Consumer OneDrive (onedrive.live.com) is not supported. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const MARKDOWN_TOOL_DEFS: readonly ToolDef[] = [
  SELECT_ROOT_DEF,
  LIST_FILES_DEF,
  GET_FILE_DEF,
  CREATE_FILE_DEF,
  UPDATE_FILE_DEF,
  EDIT_FILE_DEF,
  DELETE_FILE_DEF,
  LIST_VERSIONS_DEF,
  GET_VERSION_DEF,
  DIFF_VERSIONS_DEF,
  PREVIEW_FILE_DEF,
];
