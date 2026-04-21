// Cross-tool errors for the collab MCP tool family.
// Split out from `./shared.ts`; re-exported through the barrel.

/** Error raised when session TTL has expired. */
export class SessionExpiredError extends Error {
  constructor() {
    super(
      "The active collab session has expired. " +
        "Call session_renew to extend the TTL, or start a new session.",
    );
    this.name = "SessionExpiredError";
  }
}

/** Error raised when a file is not found (404 from Graph). */
export class FileNotFoundError extends Error {
  constructor(
    public readonly path: string,
    public readonly itemId?: string,
  ) {
    super(`File not found: ${path}${itemId ? ` (itemId: ${itemId})` : ""}`);
    this.name = "FileNotFoundError";
  }
}

/** Error raised when path lands somewhere other than the allowed locations. */
export class PathLayoutViolationError extends Error {
  constructor(public readonly path: string) {
    super(
      `Path "${path}" does not match the allowed layout (root .md, proposals/, drafts/, attachments/).`,
    );
    this.name = "PathLayoutViolationError";
  }
}

/**
 * Raised by `collab_delete_file` when the caller targets the pinned
 * authoritative markdown file. The authoritative file is the
 * project's identity — deletion is never allowed, even with an
 * explicit destructive approval. Plain `Error` per §2.5.
 */
export class RefuseDeleteAuthoritativeError extends Error {
  constructor(public readonly path: string) {
    super(
      `Refusing to delete the authoritative file "${path}". The authoritative file ` +
        "is the project's identity and cannot be removed via collab_delete_file.",
    );
    this.name = "RefuseDeleteAuthoritativeError";
  }
}

/**
 * Raised by `collab_delete_file` when the caller targets the
 * `.collab/` sentinel folder or anything inside it. The sentinel
 * carries `project.json` and `leases.json`; removing either would
 * invalidate every active session. Plain `Error` per §2.5.
 */
export class RefuseDeleteSentinelError extends Error {
  constructor(public readonly path: string) {
    super(
      `Refusing to delete "${path}" — paths inside the .collab/ sentinel folder ` +
        "are protected. Use session_open_project on a fresh folder if the project is abandoned.",
    );
    this.name = "RefuseDeleteSentinelError";
  }
}
