// Local project metadata and recents codec for collab v1.
//
// Owns the two on-disk structures under `<configDir>/projects/`:
//
//   - `<projectId>.json` — pin block + project metadata (§3.3 of
//     `docs/plans/collab-v1.md`). Contains the rename-tolerant pin
//     (`pinnedAuthoritativeFileId`, `pinnedSentinelFirstSeenAt`,
//     `pinnedAtFirstSeenCTag`) that defends collaborators from a
//     malicious cooperator silently re-pointing the sentinel at a
//     different file.
//
//   - `recent.json` — chronologically ordered list of projects the
//     human has interacted with (§3.4). Stale entries are kept with
//     `available: false` rather than dropped (constraint).
//
// W1 Day 3 only writes these files (originator path). Read /
// stale-flagging / "Forget project" affordances land with
// `session_open_project` in W4 Day 4.
//
// Both files are written atomically (write-temp + rename) for the same
// reason `src/config.ts` does it: the human can crash the MCP host at
// any time and we never want a half-written JSON file on disk.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { z } from "zod";

import { logger } from "../logger.js";
import { isNodeError } from "../errors.js";
import { mkdirOptions, writeFileOptions } from "../fs-options.js";

// ---------------------------------------------------------------------------
// Constants & paths
// ---------------------------------------------------------------------------

const PROJECTS_DIR_NAME = "projects";
const RECENTS_FILE_NAME = "recent.json";

/** Returns `<configDir>/projects`. */
export function projectsDir(configDir: string): string {
  return path.join(configDir, PROJECTS_DIR_NAME);
}

/** Returns the on-disk path for a single project's metadata file. */
export function projectMetadataPath(configDir: string, projectId: string): string {
  return path.join(projectsDir(configDir), `${projectId}.json`);
}

/** Returns the path to the recents file. */
export function recentsPath(configDir: string): string {
  return path.join(projectsDir(configDir), RECENTS_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Per-agent last-seen optimisation cache (§3.3). Pure optimisation —
 * losing it never breaks correctness, so we accept any unknown agent
 * keys without tightening the schema.
 */
const PerAgentEntrySchema = z
  .object({
    lastSeenAt: z.iso.datetime({ offset: true }),
    lastSeenCTag: z.string().min(1),
    lastSeenRevision: z.string().min(1),
  })
  .strict();

/**
 * Local project metadata as serialised at
 * `<configDir>/projects/<projectId>.json`. Strict at the top level so a
 * cooperator-edited file with unknown keys is rejected (mirrors the
 * sentinel codec's `.strict()` posture).
 */
export const ProjectMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1),
    folderId: z.string().min(1),
    folderPath: z.string().min(1),
    driveId: z.string().min(1),
    pinnedAuthoritativeFileId: z.string().min(1),
    pinnedSentinelFirstSeenAt: z.iso.datetime({ offset: true }),
    pinnedAtFirstSeenCTag: z.string().min(1),
    displayAuthoritativeFileName: z.string().min(1),
    /**
     * Mirrors the authoritative-file frontmatter `doc_id` for recovery
     * when the frontmatter is wiped (§3.1 rules). `null` until the first
     * `collab_write` lands in W2/W3 — `session_init_project` does not
     * have one yet.
     */
    docId: z.string().min(1).nullable(),
    addedAt: z.iso.datetime({ offset: true }),
    lastSeenSentinelAt: z.iso.datetime({ offset: true }),
    lastSeenAuthoritativeCTag: z.string().min(1).nullable(),
    lastSeenAuthoritativeRevision: z.string().min(1).nullable(),
    perAgent: z.record(z.string().min(1), PerAgentEntrySchema),
  })
  .strict();

export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

/** Single recents entry (§3.4). */
export const RecentEntrySchema = z
  .object({
    projectId: z.string().min(1),
    folderId: z.string().min(1),
    folderPath: z.string().min(1),
    authoritativeFile: z.string().min(1),
    lastOpened: z.iso.datetime({ offset: true }),
    role: z.enum(["originator", "collaborator"]),
    available: z.boolean(),
    unavailableReason: z.string().nullable(),
  })
  .strict();

export type RecentEntry = z.infer<typeof RecentEntrySchema>;

export const RecentsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(RecentEntrySchema),
  })
  .strict();

export type RecentsFile = z.infer<typeof RecentsFileSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a metadata or recents file fails Zod validation on read. */
export class ProjectMetadataParseError extends Error {
  constructor(
    public readonly filePath: string,
    public override readonly cause?: unknown,
  ) {
    super(`Failed to parse project metadata at ${filePath}`);
    this.name = "ProjectMetadataParseError";
  }
}

// ---------------------------------------------------------------------------
// Atomic writer
// ---------------------------------------------------------------------------

/**
 * Atomic JSON write helper shared by both files: ensures the directory
 * exists, writes a temp file in the same directory, then renames it
 * into place.
 */
async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, mkdirOptions());

  const body = JSON.stringify(data, null, 2) + "\n";
  const tmpFile = path.join(dir, `.${path.basename(filePath)}-${crypto.randomUUID()}.tmp`);

  try {
    await fs.writeFile(tmpFile, body, writeFileOptions(signal));
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Project metadata
// ---------------------------------------------------------------------------

/**
 * Persist a project metadata file. Validates with Zod on the way out so
 * a hand-constructed object cannot smuggle past the schema. Used by
 * `session_init_project` (W1 Day 3) and `session_open_project` (W4 Day 4)
 * to record the pin block on first encounter.
 */
export async function saveProjectMetadata(
  configDir: string,
  metadata: ProjectMetadata,
  signal: AbortSignal,
): Promise<void> {
  const validated = ProjectMetadataSchema.parse(metadata);
  const filePath = projectMetadataPath(configDir, validated.projectId);
  logger.debug("saving project metadata", { projectId: validated.projectId, path: filePath });
  await writeJsonAtomic(filePath, validated, signal);
}

/**
 * Read a project metadata file. Returns `null` when the file does not
 * exist, throws {@link ProjectMetadataParseError} on JSON / schema
 * failures so callers can decide whether to surface the error or treat
 * the project as unknown.
 */
export async function loadProjectMetadata(
  configDir: string,
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectMetadata | null> {
  const filePath = projectMetadataPath(configDir, projectId);
  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: "utf-8", signal });
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new ProjectMetadataParseError(filePath, err);
  }
  const result = ProjectMetadataSchema.safeParse(raw);
  if (!result.success) {
    throw new ProjectMetadataParseError(filePath, result.error);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

/**
 * Read the recents file. Returns an empty `RecentsFile` (schemaVersion 1,
 * no entries) when the file does not exist; throws on a parse / schema
 * failure so a corrupted recents file does not silently lose history.
 */
export async function loadRecents(configDir: string, signal: AbortSignal): Promise<RecentsFile> {
  const filePath = recentsPath(configDir);
  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: "utf-8", signal });
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return { schemaVersion: 1, entries: [] };
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new ProjectMetadataParseError(filePath, err);
  }
  const result = RecentsFileSchema.safeParse(raw);
  if (!result.success) {
    throw new ProjectMetadataParseError(filePath, result.error);
  }
  return result.data;
}

/**
 * Insert or refresh a recents entry. If `entry.projectId` is already
 * present, the existing row is removed and the new one prepended so the
 * most-recently-touched project sits at the head of the list. Stale
 * entries (`available: false`) are preserved (constraint).
 */
export async function upsertRecent(
  configDir: string,
  entry: RecentEntry,
  signal: AbortSignal,
): Promise<RecentsFile> {
  const validated = RecentEntrySchema.parse(entry);
  const current = await loadRecents(configDir, signal);
  const remaining = current.entries.filter((e) => e.projectId !== validated.projectId);
  const next: RecentsFile = {
    schemaVersion: 1,
    entries: [validated, ...remaining],
  };
  const filePath = recentsPath(configDir);
  logger.debug("upserting recent", { projectId: validated.projectId, path: filePath });
  await writeJsonAtomic(filePath, next, signal);
  return next;
}
