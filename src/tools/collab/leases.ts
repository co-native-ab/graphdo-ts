// `collab_acquire_section` and `collab_release_section` MCP tool registrations.
//
// Pure code-organisation extract from `src/tools/collab.ts` (W4 buffer
// refactor); no behaviour change.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CollabCTagMismatchError,
  LeaseNotHeldError,
  SectionAlreadyLeasedError,
  SectionNotFoundError,
} from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";
import { defineTool } from "../../tool-registry.js";
import { GraphClient, GraphRequestError } from "../../graph/client.js";
import { validateGraphId, type ValidatedGraphId } from "../../graph/ids.js";
import {
  createChildFolder,
  findChildFolderByName,
  getDriveItem,
  getDriveItemContent,
} from "../../collab/graph.js";
import { headingSlugSet, normaliseSectionId } from "../../collab/slug.js";
import {
  DEFAULT_LEASE_TTL_SECONDS,
  LeasesFileMissingError,
  LeasesFileTooLargeError,
  MAX_LEASE_TTL_SECONDS,
  MIN_LEASE_TTL_SECONDS,
  emptyLeases,
  pruneExpiredLeases,
  readLeases,
  writeLeasesFresh,
  writeLeasesUpdate,
  type LeaseEntry,
  type LeasesFile,
} from "../../collab/leases.js";
import { splitFrontmatter } from "../../collab/frontmatter.js";
import { AuditResult, writeAudit } from "../../collab/audit.js";
import { formatError, nowFactory } from "../shared.js";

import {
  COLLAB_ACQUIRE_SECTION_DEF,
  COLLAB_RELEASE_SECTION_DEF,
  SENTINEL_FOLDER_NAME as COLLAB_FOLDER_NAME,
  requireActiveSession,
  type ProjectMetadata,
  type SessionSnapshot,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Lease helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and read the authoritative file for the active project,
 * returning the live body so the lease tools can compute the current
 * heading slugs (§3.1 step 5 collision walk via {@link headingSlugSet}).
 *
 * Reads strictly by `pinnedAuthoritativeFileId` from the local pin
 * block — never by name — so a renamed authoritative file still resolves
 * correctly. Strips the YAML frontmatter envelope (when present) before
 * extracting the body so headings inside the envelope cannot smuggle a
 * fake slug into the comparison set.
 */
async function readAuthoritativeBodyForLease(
  client: GraphClient,
  metadata: ProjectMetadata,
  signal: AbortSignal,
): Promise<string> {
  const itemId = validateGraphId("authoritativeItemId", metadata.pinnedAuthoritativeFileId);
  const live = await getDriveItemContent(client, itemId, signal);
  const split = splitFrontmatter(live);
  return split !== null ? split.body : live;
}

/**
 * Read the leases sidecar with graceful fallback to an empty in-memory
 * view when the file does not yet exist (§2.3 graceful degradation
 * note for `collab_release_section`). Returns the read result plus a
 * `missing: true` flag so the caller (acquire) knows whether to use the
 * byPath lazy-create path or the byId CAS replace path.
 *
 * The fallback's `cTag` is `null`; the caller must branch on
 * `result.missing` to choose the write target.
 */
interface LoadedLeases {
  file: LeasesFile;
  itemId: ValidatedGraphId | null;
  cTag: string | null;
  /** True when the sidecar did not exist; caller treats this as "no active leases". */
  missing: boolean;
}

async function loadLeasesGracefully(
  client: GraphClient,
  projectFolderId: ValidatedGraphId,
  now: Date,
  signal: AbortSignal,
): Promise<LoadedLeases> {
  try {
    const { file, item } = await readLeases(client, projectFolderId, signal);
    const pruned = pruneExpiredLeases(file, now);
    return {
      file: pruned,
      itemId: validateGraphId("leasesItemId", item.id),
      cTag: item.cTag ?? null,
      missing: false,
    };
  } catch (err) {
    if (err instanceof LeasesFileMissingError) {
      return { file: emptyLeases(), itemId: null, cTag: null, missing: true };
    }
    throw err;
  }
}

/**
 * Resolve (or lazy-create) the project's `.collab/` folder so the
 * lazy-create path of {@link writeLeasesFresh} has somewhere to PUT the
 * sidecar. The sentinel write in `session_init_project` already created
 * the folder, but a tampered project (.collab deleted) would re-create
 * it here — defence in depth, the lease helper does not validate the
 * sentinel.
 */
async function ensureCollabFolderId(
  client: GraphClient,
  projectFolderId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<ValidatedGraphId> {
  const existing = await findChildFolderByName(client, projectFolderId, COLLAB_FOLDER_NAME, signal);
  const folder =
    existing ?? (await createChildFolder(client, projectFolderId, COLLAB_FOLDER_NAME, signal));
  return validateGraphId("collabFolderId", folder.id);
}

/** Clamp `ttlSeconds` to the §2.3 [1, 3600] range with a default of 600. */
function clampLeaseTtl(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LEASE_TTL_SECONDS;
  const truncated = Math.floor(raw);
  if (truncated < MIN_LEASE_TTL_SECONDS) return MIN_LEASE_TTL_SECONDS;
  if (truncated > MAX_LEASE_TTL_SECONDS) return MAX_LEASE_TTL_SECONDS;
  return truncated;
}

/**
 * Build a fresh {@link LeaseEntry} from the current session snapshot
 * and TTL. The session snapshot's `userOid` is not surfaced in
 * `agentDisplayName` per §3.2.1 — display-only metadata never leaks an
 * `oid`; we use the agent slug suffix as a human-readable hint
 * instead.
 */
function buildLeaseEntry(
  session: SessionSnapshot,
  sectionSlug: string,
  ttlSeconds: number,
  now: Date,
): LeaseEntry {
  return {
    sectionSlug,
    agentId: session.agentId,
    // The session's `agentId` is `<oidPrefix>-<clientSlug>-<sessionPrefix>`.
    // The middle segment (clientSlug) is the most useful display chunk —
    // never leaks the `oid` and tells the human which client is holding.
    agentDisplayName: session.agentId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
}

/** Compose the agent-facing acquire/release output. */
function formatLeaseOutput(args: {
  action: "acquired" | "released" | "no-op";
  sectionSlug: string;
  newLeasesCTag: string;
  expiresAt?: string;
  remainingLeases: number;
}): string {
  const lines = [`${args.action}: ${args.sectionSlug}`, `leasesCTag: ${args.newLeasesCTag}`];
  if (args.expiresAt !== undefined) {
    lines.push(`expiresAt: ${args.expiresAt}`);
  }
  lines.push(`activeLeases: ${args.remainingLeases}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// collab_acquire_section
// ---------------------------------------------------------------------------

export function registerCollabAcquireSection(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
    server,
    COLLAB_ACQUIRE_SECTION_DEF,
    {
      inputSchema: {
        sectionId: z
          .string()
          .min(1)
          .describe(
            "Raw heading text (e.g. '## Introduction') or pre-computed " +
              "GitHub-flavored slug (e.g. 'introduction'). Both shapes are " +
              "normalised through the same slug algorithm.",
          ),
        ttlSeconds: z
          .number()
          .int()
          .min(MIN_LEASE_TTL_SECONDS)
          .max(MAX_LEASE_TTL_SECONDS)
          .optional()
          .describe(
            `Lease TTL in seconds; default ${String(DEFAULT_LEASE_TTL_SECONDS)}, ` +
              `max ${String(MAX_LEASE_TTL_SECONDS)}.`,
          ),
        leasesCTag: z
          .string()
          .describe(
            "Opaque cTag for `.collab/leases.json`, surfaced by " +
              "session_status. Empty string accepted on the very first " +
              "acquire (when the sidecar does not yet exist).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sectionId, ttlSeconds, leasesCTag }, { signal }) => {
      try {
        const { session, metadata } = await requireActiveSession(config, signal);
        const ttl = clampLeaseTtl(ttlSeconds);
        const slug = normaliseSectionId(sectionId);

        const client = config.graphClient;

        // 1. Validate the slug exists in the live authoritative body.
        //    SectionNotFoundError is a hard refusal — no slug-drift
        //    fallback in v1 (lands with collab_apply_proposal in W4 Day 3).
        const body = await readAuthoritativeBodyForLease(client, metadata, signal);
        const slugs = headingSlugSet(body);
        if (!slugs.has(slug)) {
          return formatError(
            "collab_acquire_section",
            new SectionNotFoundError(sectionId, slug, [...slugs]),
          );
        }

        // 2. Read the leases sidecar (graceful 404 → empty in-memory view).
        const projectFolderId = validateGraphId("projectFolderId", metadata.folderId);
        const now = nowFactory(config)();
        const loaded = await loadLeasesGracefully(client, projectFolderId, now, signal);

        // 3. CAS pre-check on the agent-supplied leasesCTag. When the
        //    sidecar already exists the supplied cTag must match the
        //    live cTag — otherwise we surface the mismatch with the
        //    current state so the agent can re-read and retry. When
        //    the sidecar is missing the supplied cTag is ignored
        //    (lazy-create path).
        if (!loaded.missing) {
          if (loaded.cTag !== null && leasesCTag !== loaded.cTag && loaded.itemId !== null) {
            // Mirror the §2.6 CollabCTagMismatchError shape so the
            // agent sees the same envelope used for content writes.
            const liveItemId = loaded.itemId;
            const liveItem = await getDriveItem(client, liveItemId, signal);
            return formatError(
              "collab_acquire_section",
              new CollabCTagMismatchError(
                liveItemId,
                leasesCTag,
                liveItem.cTag,
                liveItem.version,
                liveItem,
              ),
            );
          }
        }

        // 4. Reject when an active lease for this slug is held by a
        //    different agent. The pruner has already dropped expired
        //    entries from `loaded.file`.
        const existing = loaded.file.leases.find((l) => l.sectionSlug === slug);
        if (existing !== undefined && existing.agentId !== session.agentId) {
          return formatError(
            "collab_acquire_section",
            new SectionAlreadyLeasedError(
              slug,
              existing.agentId,
              existing.agentDisplayName,
              existing.expiresAt,
            ),
          );
        }

        // 5. Build the new in-memory leases view: drop any prior
        //    entry for this slug (re-acquire by the same agent
        //    refreshes the TTL — the natural extension semantic) and
        //    append the fresh entry.
        const filtered = loaded.file.leases.filter((l) => l.sectionSlug !== slug);
        const fresh = buildLeaseEntry(session, slug, ttl, now);
        const nextFile: LeasesFile = {
          schemaVersion: loaded.file.schemaVersion,
          leases: [...filtered, fresh],
        };

        // 6. Write back. Lazy-create when missing; CAS replace otherwise.
        //    The lazy-create 409 race is handled by re-reading and
        //    falling through to the CAS replace path exactly once.
        let writtenItem;
        try {
          if (loaded.missing) {
            const collabFolderId = await ensureCollabFolderId(client, projectFolderId, signal);
            try {
              writtenItem = await writeLeasesFresh(client, collabFolderId, nextFile, signal);
            } catch (err) {
              if (err instanceof GraphRequestError && err.statusCode === 409) {
                // Race: somebody else created it between our read and
                // our write. Re-read, merge our entry on top of the
                // freshly-loaded state, and retry as a CAS replace.
                const reloaded = await loadLeasesGracefully(client, projectFolderId, now, signal);
                if (reloaded.missing || reloaded.itemId === null || reloaded.cTag === null) {
                  throw err;
                }
                // Re-check holder on the freshly-loaded state — the
                // race may have created an entry for this slug.
                const racedExisting = reloaded.file.leases.find((l) => l.sectionSlug === slug);
                if (racedExisting !== undefined && racedExisting.agentId !== session.agentId) {
                  return formatError(
                    "collab_acquire_section",
                    new SectionAlreadyLeasedError(
                      slug,
                      racedExisting.agentId,
                      racedExisting.agentDisplayName,
                      racedExisting.expiresAt,
                    ),
                  );
                }
                const racedFiltered = reloaded.file.leases.filter((l) => l.sectionSlug !== slug);
                const racedNext: LeasesFile = {
                  schemaVersion: reloaded.file.schemaVersion,
                  leases: [...racedFiltered, fresh],
                };
                writtenItem = await writeLeasesUpdate(
                  client,
                  reloaded.itemId,
                  reloaded.cTag,
                  racedNext,
                  signal,
                );
              } else {
                throw err;
              }
            }
          } else {
            if (loaded.itemId === null || loaded.cTag === null) {
              throw new Error("internal: leases item id/cTag missing on CAS path");
            }
            writtenItem = await writeLeasesUpdate(
              client,
              loaded.itemId,
              loaded.cTag,
              nextFile,
              signal,
            );
          }
        } catch (err) {
          if (err instanceof CollabCTagMismatchError || err instanceof LeasesFileTooLargeError) {
            return formatError("collab_acquire_section", err);
          }
          throw err;
        }

        // 7. §3.6 audit: record the lease acquisition as a tool_call so
        //    the post-hoc reviewer sees who acquired which section.
        //    Lease ops are FREE — no write-budget increment.
        await writeAudit(
          config,
          {
            sessionId: session.sessionId,
            agentId: session.agentId,
            userOid: session.userOid,
            projectId: metadata.projectId,
            tool: "collab_acquire_section",
            result: AuditResult.Success,
            type: "tool_call",
            details: {
              inputSummary: { sectionId: slug },
              cTagBefore: loaded.cTag,
              cTagAfter: writtenItem.cTag ?? null,
            },
          },
          signal,
        );

        return {
          content: [
            {
              type: "text",
              text: formatLeaseOutput({
                action: "acquired",
                sectionSlug: slug,
                newLeasesCTag: writtenItem.cTag ?? "(unknown)",
                expiresAt: fresh.expiresAt,
                remainingLeases: nextFile.leases.length,
              }),
            },
          ],
        };
      } catch (err) {
        return formatError("collab_acquire_section", err);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// collab_release_section
// ---------------------------------------------------------------------------

export function registerCollabReleaseSection(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
    server,
    COLLAB_RELEASE_SECTION_DEF,
    {
      inputSchema: {
        sectionId: z
          .string()
          .min(1)
          .describe("Raw heading text or pre-computed slug (same shape as acquire)."),
        leasesCTag: z
          .string()
          .describe("Opaque cTag for `.collab/leases.json`, surfaced by session_status."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // §2.4 row: collab_release_section has idempotentHint = true.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sectionId, leasesCTag }, { signal }) => {
      try {
        const { session, metadata } = await requireActiveSession(config, signal);
        const slug = normaliseSectionId(sectionId);

        const client = config.graphClient;

        const projectFolderId = validateGraphId("projectFolderId", metadata.folderId);
        const now = nowFactory(config)();
        const loaded = await loadLeasesGracefully(client, projectFolderId, now, signal);

        // Graceful degradation: leases sidecar gone → no active leases.
        // Releasing a non-existent lease is a no-op success per §2.3.
        if (loaded.missing) {
          return {
            content: [
              {
                type: "text",
                text: formatLeaseOutput({
                  action: "no-op",
                  sectionSlug: slug,
                  newLeasesCTag: "(no sidecar)",
                  remainingLeases: 0,
                }),
              },
            ],
          };
        }

        // CAS pre-check.
        if (loaded.cTag !== null && leasesCTag !== loaded.cTag && loaded.itemId !== null) {
          const liveItemId = loaded.itemId;
          const liveItem = await getDriveItem(client, liveItemId, signal);
          return formatError(
            "collab_release_section",
            new CollabCTagMismatchError(
              liveItemId,
              leasesCTag,
              liveItem.cTag,
              liveItem.version,
              liveItem,
            ),
          );
        }

        const existing = loaded.file.leases.find((l) => l.sectionSlug === slug);
        if (existing === undefined) {
          // Lease already absent (expired-and-pruned, or never held).
          // No-op success, but still report the current cTag so the
          // caller's local view stays current.
          return {
            content: [
              {
                type: "text",
                text: formatLeaseOutput({
                  action: "no-op",
                  sectionSlug: slug,
                  newLeasesCTag: loaded.cTag ?? "(unknown)",
                  remainingLeases: loaded.file.leases.length,
                }),
              },
            ],
          };
        }
        if (existing.agentId !== session.agentId) {
          return formatError(
            "collab_release_section",
            new LeaseNotHeldError(slug, session.agentId, existing.agentId),
          );
        }

        const nextFile: LeasesFile = {
          schemaVersion: loaded.file.schemaVersion,
          leases: loaded.file.leases.filter((l) => l.sectionSlug !== slug),
        };

        let writtenItem;
        try {
          if (loaded.itemId === null || loaded.cTag === null) {
            throw new Error("internal: leases item id/cTag missing on release CAS path");
          }
          writtenItem = await writeLeasesUpdate(
            client,
            loaded.itemId,
            loaded.cTag,
            nextFile,
            signal,
          );
        } catch (err) {
          if (err instanceof CollabCTagMismatchError || err instanceof LeasesFileTooLargeError) {
            return formatError("collab_release_section", err);
          }
          throw err;
        }

        await writeAudit(
          config,
          {
            sessionId: session.sessionId,
            agentId: session.agentId,
            userOid: session.userOid,
            projectId: metadata.projectId,
            tool: "collab_release_section",
            result: AuditResult.Success,
            type: "tool_call",
            details: {
              inputSummary: { sectionId: slug },
              cTagBefore: loaded.cTag,
              cTagAfter: writtenItem.cTag ?? null,
            },
          },
          signal,
        );

        return {
          content: [
            {
              type: "text",
              text: formatLeaseOutput({
                action: "released",
                sectionSlug: slug,
                newLeasesCTag: writtenItem.cTag ?? "(unknown)",
                remainingLeases: nextFile.leases.length,
              }),
            },
          ],
        };
      } catch (err) {
        return formatError("collab_release_section", err);
      }
    },
  );
}
