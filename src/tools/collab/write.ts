// `collab_write` MCP tool registration.
//
// Pure code-organisation extract from `src/tools/collab.ts` (W4 buffer
// refactor); no behaviour change. The proposal-diversion path
// (`conflictMode: "proposal"`) reuses {@link runProposalWrite} from
// `./shared.ts`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  AuthenticationRequiredError,
  BudgetExhaustedError,
  CollabCTagMismatchError,
  DocIdRecoveryRequiredError,
  ExternalSourceDeclinedError,
  OutOfScopeError,
  ProposalIdCollisionError,
} from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";
import { defineTool } from "../../tool-registry.js";
import { GraphClient, GraphRequestError } from "../../graph/client.js";
import { validateGraphId, type ValidatedGraphId } from "../../graph/ids.js";
import { MarkdownFileTooLargeError } from "../../graph/markdown.js";
import {
  ProjectFileAlreadyExistsError,
  getDriveItemContent,
  writeProjectFile,
  type WriteProjectFileTarget,
} from "../../collab/graph.js";
import { PREAMBLE_SYNTHETIC_SLUG } from "../../collab/slug.js";
import { computeSectionContentHash, walkSectionsWithHashes } from "../../collab/authorship.js";
import { splitFrontmatter, type FrontmatterResetAudit } from "../../collab/frontmatter.js";
import {
  AuditApprovalOutcome,
  AuditResult,
  writeAudit,
  type AuditInputSummary,
} from "../../collab/audit.js";
import { formatError } from "../shared.js";
import type { DriveItem } from "../../graph/types.js";

import {
  COLLAB_WRITE_DEF,
  contentTypeForFileName,
  ensureParentFolder,
  requireActiveSession,
  scopeCheckedResolve,
  splitScopedPath,
  toAuditConflictMode,
  toAuditResetReason,
  toAuditWriteSource,
} from "./shared.js";
import {
  persistAuthoritativeMetadata,
  runAuthoritativeWrite,
  runExternalSourceReprompt,
  runProposalWrite,
} from "./ops.js";

export function registerCollabWrite(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
    server,
    COLLAB_WRITE_DEF,
    {
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Scope-relative path inside the active project, e.g. " +
              "'<authoritativeFile>.md' for the authoritative file, " +
              "'proposals/p-foo.md', 'drafts/scratch.md', or " +
              "'attachments/diagram.png'.",
          ),
        content: z.string().describe("UTF-8 file content. Must be ≤ 4 MiB after encoding."),
        cTag: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Opaque cTag previously returned by collab_read or another " +
              "collab write. Required for updates to existing files; " +
              "omit only when creating a new non-authoritative file " +
              "(`/proposals/`, `/drafts/`, `/attachments/`).",
          ),
        source: z
          .enum(["chat", "project", "external"])
          .describe(
            "Where this content originated. 'chat' = the human typed it " +
              "this turn; 'project' = read via collab_read in this session; " +
              "'external' = anything else (web fetch, prior session, " +
              "generated). Writes with source='external' trigger a browser " +
              "re-approval before the write is issued.",
          ),
        conflictMode: z
          .enum(["fail", "proposal"])
          .default("fail")
          .describe(
            "Behaviour on cTag mismatch (HTTP 412). 'fail' returns an " +
              "error with the current cTag and revision so the agent can " +
              "re-read and reconcile. 'proposal' diverts the new content " +
              "to /proposals/<ulid>.md (lands with collab_create_proposal " +
              "in W4 Day 2 — currently rejected with a clear message).",
          ),
        intent: z
          .string()
          .max(2048)
          .optional()
          .describe(
            "Free-text intent shown in re-prompt forms (external-source). " +
              "Helps the human decide whether to approve.",
          ),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, content, cTag, source, conflictMode, intent }, { signal }) => {
      try {
        const { session, metadata } = await requireActiveSession(config, signal);

        // Pre-check the write budget so external-source writes never
        // open a browser tab the agent has no budget to honour. The
        // §5.2 contract: writes count toward the budget on success or
        // diversion; we surface BudgetExhaustedError before the
        // re-prompt to keep the human's time uncontested.
        if (session.writesUsed >= session.writeBudgetTotal) {
          return formatError(
            "collab_write",
            new BudgetExhaustedError(session.writesUsed, session.writeBudgetTotal),
          );
        }

        const token = await config.authenticator.token(signal);
        const client = new GraphClient(config.graphBaseUrl, {
          getToken: () => Promise.resolve(token),
        });

        // Resolve the target — this also enforces §4.6 scope before
        // any external re-prompt opens or any write is issued.
        let resolvedItem: DriveItem | null = null;
        let isAuthoritative = false;
        let writeIsCreate = false;
        let parentFolderId: ValidatedGraphId | null = null;
        let leafName = "";
        try {
          resolvedItem = await scopeCheckedResolve(config, metadata, path, signal);
          isAuthoritative = resolvedItem.id === metadata.pinnedAuthoritativeFileId;
        } catch (err) {
          if (err instanceof OutOfScopeError) {
            return formatError("collab_write", err);
          }
          // 404 from the scope resolver means the path-name does not
          // exist yet. That's only legal for non-authoritative files
          // (the authoritative file always exists post-init); the
          // resolver itself rejects authoritative-name creates because
          // the resolved item id wouldn't match the pinned id, but we
          // double-check below by inspecting the path layout.
          if (!(err instanceof GraphRequestError && err.statusCode === 404)) {
            throw err;
          }
          writeIsCreate = true;
          const split = splitScopedPath(path);
          leafName = split.leafName;
          if (leafName.length === 0) {
            return formatError("collab_write", new Error(`Path "${path}" has no file name.`));
          }
          // The §4.6 scope resolver already validated the layout for
          // resolvable paths; for create paths we re-derive the parent
          // folder under the project root using the same group names
          // the layout enforces.
          const projectFolderId = validateGraphId("projectFolderId", metadata.folderId);
          try {
            parentFolderId = await ensureParentFolder(
              client,
              projectFolderId,
              split.parentSegments,
              signal,
            );
          } catch (parentErr) {
            return formatError("collab_write", parentErr);
          }
        }

        // Authoritative writes require a cTag — the file always
        // exists, so omitting cTag would be a CAS-bypass attempt.
        if (isAuthoritative && (cTag === undefined || cTag.length === 0)) {
          return formatError(
            "collab_write",
            new Error(
              "cTag is required when writing the authoritative file. " +
                "Re-read with collab_read to fetch the current cTag.",
            ),
          );
        }
        // Updates to non-authoritative files also require a cTag (the
        // CAS contract). Only first-write byPath creates may skip it.
        if (!isAuthoritative && !writeIsCreate && (cTag === undefined || cTag.length === 0)) {
          return formatError(
            "collab_write",
            new Error(
              `cTag is required when updating "${path}" (file already exists). ` +
                "Re-read with collab_read to fetch the current cTag.",
            ),
          );
        }

        // Pre-flight payload size guard so we surface a clear error
        // before any external re-prompt asks the human about a write
        // we know will fail.
        const bytes = Buffer.byteLength(content, "utf-8");

        // Open the external-source re-approval form before doing any
        // Graph write so a "Cancel" returns ExternalSourceDeclinedError
        // without side-effects (per §5.2.4).
        if (source === "external") {
          try {
            await runExternalSourceReprompt(
              config,
              {
                path,
                intent,
                sourceCounters: session.sourceCounters,
                isCreate: writeIsCreate,
                bytes,
              },
              signal,
            );
          } catch (err) {
            if (err instanceof ExternalSourceDeclinedError) {
              // §3.6 audit: record the declined external-source
              // approval so post-hoc review sees the human said no
              // and no Graph write was issued.
              await writeAudit(
                config,
                {
                  sessionId: session.sessionId,
                  agentId: session.agentId,
                  userOid: session.userOid,
                  projectId: metadata.projectId,
                  tool: "collab_write",
                  result: AuditResult.Failure,
                  intent,
                  type: "external_source_approval",
                  details: {
                    tool: "collab_write",
                    path,
                    outcome: AuditApprovalOutcome.Declined,
                    csrfTokenMatched: true,
                  },
                },
                signal,
              );
              return formatError("collab_write", err);
            }
            throw err;
          }
          // Approval succeeded — record the audit before the write
          // so the order in the JSONL matches the order of events.
          await writeAudit(
            config,
            {
              sessionId: session.sessionId,
              agentId: session.agentId,
              userOid: session.userOid,
              projectId: metadata.projectId,
              tool: "collab_write",
              result: AuditResult.Success,
              intent,
              type: "external_source_approval",
              details: {
                tool: "collab_write",
                path,
                outcome: AuditApprovalOutcome.Approved,
                csrfTokenMatched: true,
              },
            },
            signal,
          );
        }

        const cTagBefore = resolvedItem?.cTag ?? null;
        let updated: DriveItem;
        let writtenDocId: string | null = null;
        let frontmatterReset: FrontmatterResetAudit | null = null;
        let divertedProposalId: string | null = null;
        try {
          if (isAuthoritative) {
            if (resolvedItem === null) {
              throw new Error("internal: resolvedItem missing for authoritative write");
            }
            if (cTag === undefined) {
              throw new Error("internal: cTag missing for authoritative write");
            }
            const auth = await runAuthoritativeWrite(
              config,
              client,
              metadata,
              resolvedItem,
              cTag,
              content,
              signal,
            );
            updated = auth.updated;
            writtenDocId = auth.writtenDocId;
            frontmatterReset = auth.frontmatterReset;
          } else if (writeIsCreate) {
            if (parentFolderId === null) {
              throw new Error("internal: parentFolderId missing for byPath create");
            }
            const target: WriteProjectFileTarget = {
              kind: "create",
              folderId: parentFolderId,
              fileName: leafName,
              contentType: contentTypeForFileName(leafName),
            };
            updated = await writeProjectFile(client, target, content, signal);
          } else {
            if (resolvedItem === null) {
              throw new Error("internal: resolvedItem missing for byId replace");
            }
            if (cTag === undefined) {
              throw new Error("internal: cTag missing for byId replace");
            }
            const validatedItemId = validateGraphId("resolvedItemId", resolvedItem.id);
            const target: WriteProjectFileTarget = {
              kind: "replace",
              itemId: validatedItemId,
              cTag: cTag,
              contentType: contentTypeForFileName(resolvedItem.name),
            };
            updated = await writeProjectFile(client, target, content, signal);
          }
        } catch (err) {
          // §2.3: `conflictMode: "proposal"` diverts an authoritative
          // CAS-mismatch into a `/proposals/<ulid>.md` write +
          // frontmatter `proposals[]` entry, using the live cTag the
          // mismatch error carried. Diversion only applies to
          // authoritative writes; non-authoritative 412s mean a
          // cooperator overwrote a draft / proposal file under us and
          // there is no diversion target to fall back to.
          if (
            err instanceof CollabCTagMismatchError &&
            conflictMode === "proposal" &&
            isAuthoritative &&
            resolvedItem !== null
          ) {
            try {
              const liveContent = await getDriveItemContent(
                client,
                validateGraphId("authoritativeItemId", resolvedItem.id),
                signal,
              );
              const liveBody = (() => {
                const split = splitFrontmatter(liveContent);
                return split !== null ? split.body : liveContent;
              })();
              const sections = walkSectionsWithHashes(liveBody);
              const preamble = sections.find((s) => s.slug === PREAMBLE_SYNTHETIC_SLUG);
              const preambleHash = preamble?.contentHash ?? computeSectionContentHash("");
              const liveCTag = err.currentCTag ?? "";
              if (liveCTag.length === 0) {
                // Without a live cTag we cannot CAS-write the
                // frontmatter update; surface the original mismatch.
                return formatError("collab_write", err);
              }
              const proposalResult = await runProposalWrite(
                {
                  client,
                  config,
                  metadata,
                  session,
                  targetSectionSlug: PREAMBLE_SYNTHETIC_SLUG,
                  targetSectionContentHashAtCreate: preambleHash,
                  proposalBody: content,
                  rationale: intent ?? "",
                  source,
                  authoritativeCTag: liveCTag,
                  liveAuthoritativeItem: err.currentItem,
                  liveAuthoritativeContent: liveContent,
                },
                signal,
              );
              updated = proposalResult.proposalItem;
              divertedProposalId = proposalResult.proposalId;
              writtenDocId = proposalResult.newDocId;
              // Persist the new authoritative cTag/revision under the
              // pin block so subsequent reads see the up-to-date
              // values without an extra round-trip.
              await persistAuthoritativeMetadata(
                config,
                metadata,
                proposalResult.authoritativeUpdated,
                proposalResult.newDocId,
                signal,
              );
            } catch (divErr) {
              if (
                divErr instanceof CollabCTagMismatchError ||
                divErr instanceof MarkdownFileTooLargeError ||
                divErr instanceof ProposalIdCollisionError ||
                divErr instanceof DocIdRecoveryRequiredError
              ) {
                return formatError("collab_write", divErr);
              }
              throw divErr;
            }
          } else if (
            err instanceof MarkdownFileTooLargeError ||
            err instanceof CollabCTagMismatchError ||
            err instanceof ProjectFileAlreadyExistsError ||
            err instanceof DocIdRecoveryRequiredError
          ) {
            return formatError("collab_write", err);
          } else {
            throw err;
          }
        }

        // Persist counters + per-write cache updates atomically with
        // each step so a crash mid-flow leaves a coherent state.
        await config.sessionRegistry.incrementWrites(signal);
        await config.sessionRegistry.incrementSource(source, signal);

        // For non-diverted authoritative writes, refresh the pin
        // block. The diversion path already persisted the new
        // authoritative cTag/revision (via the proposal-write helper)
        // before reaching this point.
        if (isAuthoritative && divertedProposalId === null && writtenDocId !== null) {
          await persistAuthoritativeMetadata(config, metadata, updated, writtenDocId, signal);
        }

        // §3.6 audit: when the live frontmatter was missing /
        // malformed, emit a single `frontmatter_reset` for the write
        // that recovered the doc_id. The next read sees the
        // re-injected envelope and does not duplicate the entry.
        if (frontmatterReset !== null) {
          await writeAudit(
            config,
            {
              sessionId: session.sessionId,
              agentId: session.agentId,
              userOid: session.userOid,
              projectId: metadata.projectId,
              tool: "collab_write",
              result: AuditResult.Success,
              type: "frontmatter_reset",
              details: {
                reason: toAuditResetReason(frontmatterReset.reason),
                previousRevision: frontmatterReset.previousRevision,
                recoveredDocId: frontmatterReset.recoveredDocId,
              },
            },
            signal,
          );
        }

        // §3.6 audit: record the successful write. inputSummary
        // carries only allow-listed fields (the writer enforces this
        // again); content / body / rationale never reach disk.
        const inputSummary: AuditInputSummary = {
          path,
          source: toAuditWriteSource(source),
          conflictMode: toAuditConflictMode(conflictMode),
          contentSizeBytes: bytes,
        };
        if (divertedProposalId !== null) {
          inputSummary.proposalId = divertedProposalId;
        }
        await writeAudit(
          config,
          {
            sessionId: session.sessionId,
            agentId: session.agentId,
            userOid: session.userOid,
            projectId: metadata.projectId,
            tool: "collab_write",
            result: AuditResult.Success,
            intent,
            type: "tool_call",
            details: {
              inputSummary,
              cTagBefore,
              cTagAfter: updated.cTag ?? null,
              revisionAfter: updated.version ?? null,
              bytes,
              source: toAuditWriteSource(source),
              resolvedItemId: updated.id,
            },
          },
          signal,
        );

        const lines = [
          `wrote: ${updated.name} (${updated.id})`,
          `bytes: ${updated.size ?? bytes}`,
          `cTag: ${updated.cTag ?? "unknown"}`,
          updated.version !== undefined ? `revision: ${updated.version}` : "revision: (unknown)",
          `kind: ${divertedProposalId !== null ? "diverted" : writeIsCreate ? "created" : "replaced"}`,
          `isAuthoritative: ${isAuthoritative && divertedProposalId === null ? "true" : "false"}`,
          `source: ${source}`,
        ];
        if (divertedProposalId !== null) {
          lines.push(`diverted: ${path} → proposals/${divertedProposalId}.md`);
          lines.push(`proposalId: ${divertedProposalId}`);
        }
        const refreshed = config.sessionRegistry.snapshot();
        if (refreshed !== null) {
          lines.push(`writes: ${refreshed.writesUsed} / ${refreshed.writeBudgetTotal}`);
          lines.push(
            `source counters: chat=${refreshed.sourceCounters.chat} ` +
              `project=${refreshed.sourceCounters.project} ` +
              `external=${refreshed.sourceCounters.external}`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err instanceof AuthenticationRequiredError) {
          return formatError("collab_write", err);
        }
        return formatError("collab_write", err);
      }
    },
  );
}
