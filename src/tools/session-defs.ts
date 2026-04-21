// Static {@link ToolDef} entries for the `session_*` MCP tool family.
// Split out from `./session.ts`; re-exported through the barrel.

import { GraphScope } from "../scopes.js";
import type { ToolDef } from "../tool-registry.js";

export const SESSION_INIT_DEF: ToolDef = {
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

export const SESSION_STATUS_DEF: ToolDef = {
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

export const SESSION_OPEN_DEF: ToolDef = {
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

export const SESSION_RENEW_DEF: ToolDef = {
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

export const SESSION_RECOVER_DOC_ID_DEF: ToolDef = {
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
