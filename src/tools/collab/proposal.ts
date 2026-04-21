// `collab_create_proposal` and `collab_apply_proposal` MCP tool registrations.
//
// Pure code-organisation extract from `src/tools/collab.ts` (W4 buffer
// refactor); no behaviour change. Both tools share the §3.1 frontmatter
// surgery + §2.3 anchor resolution helpers from `./shared.ts`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createTwoFilesPatch } from "diff";

import {
  BudgetExhaustedError,
  CollabCTagMismatchError,
  DestructiveApprovalDeclinedError,
  DestructiveBudgetExhaustedError,
  DocIdRecoveryRequiredError,
  ExternalSourceDeclinedError,
  OutOfScopeError,
  ProposalAlreadyAppliedError,
  ProposalIdCollisionError,
  ProposalNotFoundError,
  SectionAnchorLostError,
} from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";
import { defineTool } from "../../tool-registry.js";
import { GraphRequestError } from "../../graph/client.js";
import { validateGraphId } from "../../graph/ids.js";
import { MarkdownFileTooLargeError } from "../../graph/markdown.js";
import { getDriveItem, getDriveItemContent, writeAuthoritative } from "../../collab/graph.js";
import { normaliseSectionId } from "../../collab/slug.js";
import {
  classifyAuthorshipMatch,
  computeSectionContentHash,
  findSectionByAnchor,
} from "../../collab/authorship.js";
import {
  joinFrontmatter,
  readMarkdownFrontmatter,
  serializeFrontmatter,
  splitFrontmatter,
  type CollabFrontmatter,
} from "../../collab/frontmatter.js";
import {
  AuditApprovalOutcome,
  AuditMatchedBy,
  AuditResult,
  hashDiffSummary,
  writeAudit,
  type AuditInputSummary,
} from "../../collab/audit.js";
import { formatError, nowFactory } from "../shared.js";
import type { DriveItem } from "../../graph/types.js";

import {
  COLLAB_APPLY_PROPOSAL_DEF,
  COLLAB_CREATE_PROPOSAL_DEF,
  FileNotFoundError,
  extractRevisionFromCTag,
  requireActiveSession,
  scopeCheckedResolve,
  toAuditWriteSource,
  uniqueAuthorLabels,
} from "./shared.js";
import {
  persistAuthoritativeMetadata,
  runDestructiveReprompt,
  runExternalSourceReprompt,
  runProposalWrite,
} from "./ops.js";

// ---------------------------------------------------------------------------
// collab_create_proposal
// ---------------------------------------------------------------------------

export function registerCollabCreateProposal(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
    server,
    COLLAB_CREATE_PROPOSAL_DEF,
    {
      inputSchema: {
        targetSectionId: z
          .string()
          .min(1)
          .describe(
            "Section to be replaced — raw heading text (e.g. " +
              "'## Introduction') or a pre-computed GitHub-flavored slug " +
              "(e.g. 'introduction'). Must match a current heading in the " +
              "authoritative file at create time.",
          ),
        body: z
          .string()
          .describe(
            "Proposed new body for the target section. Written verbatim " +
              "to /proposals/<ulid>.md. Must be ≤ 4 MiB after UTF-8 encoding.",
          ),
        rationale: z
          .string()
          .max(8192)
          .optional()
          .describe(
            "Free-text explanation persisted in the authoritative " +
              "frontmatter `proposals[].rationale` for the human reviewer.",
          ),
        source: z
          .enum(["chat", "project", "external"])
          .describe(
            "Where the proposal body originated. 'external' triggers a " +
              "browser re-approval before any Graph round-trip, mirroring " +
              "collab_write.source semantics.",
          ),
        authoritativeCTag: z
          .string()
          .min(1)
          .describe(
            "Opaque cTag for the authoritative file, from the most recent " +
              "collab_read. Required — the frontmatter update is a CAS write.",
          ),
        intent: z
          .string()
          .max(2048)
          .optional()
          .describe(
            "Free-text intent shown on re-prompt forms (external-source). " +
              "Helps the human decide whether to approve.",
          ),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ targetSectionId, body, rationale, source, authoritativeCTag, intent }, { signal }) => {
      try {
        const { session, metadata } = await requireActiveSession(config, signal);

        // Pre-flight write-budget check (mirrors collab_write — keeps
        // the human's time uncontested when the budget is gone).
        if (session.writesUsed >= session.writeBudgetTotal) {
          return formatError(
            "collab_create_proposal",
            new BudgetExhaustedError(session.writesUsed, session.writeBudgetTotal),
          );
        }

        const client = config.graphClient;

        // 1. Read the live authoritative file: needed to validate the
        //    target section anchor and to capture the current body so
        //    the frontmatter update step does not clobber it.
        const authoritativeItemId = validateGraphId(
          "authoritativeItemId",
          metadata.pinnedAuthoritativeFileId,
        );
        const liveAuthoritativeItem = await getDriveItem(client, authoritativeItemId, signal);
        const liveContent = await getDriveItemContent(client, authoritativeItemId, signal);
        const liveSplit = splitFrontmatter(liveContent);
        const liveBody = liveSplit !== null ? liveSplit.body : liveContent;

        // 2. Validate the target section anchor: at create time the
        //    slug must uniquely identify a current heading. The
        //    slug-drift fallback is reserved for apply (W4 Day 3) —
        //    create time has no `contentHashAtCreate` to fall back to.
        const targetSlug = normaliseSectionId(targetSectionId);
        const anchorResult = findSectionByAnchor(liveBody, targetSlug);
        if (anchorResult.kind !== "slug_match") {
          const currentSlugs = anchorResult.kind === "anchor_lost" ? anchorResult.currentSlugs : [];
          return formatError(
            "collab_create_proposal",
            new SectionAnchorLostError("(unminted)", targetSlug, "", currentSlugs),
          );
        }
        const targetSection = anchorResult.section;
        const contentHashAtCreate = targetSection.contentHash;

        // 3. External-source re-approval form (before any Graph
        //    write). Cancel → ExternalSourceDeclinedError + audit.
        const bytes = Buffer.byteLength(body, "utf-8");
        if (source === "external") {
          try {
            await runExternalSourceReprompt(
              config,
              {
                path: `proposals/<new>.md (target: ${targetSlug})`,
                intent,
                sourceCounters: session.sourceCounters,
                isCreate: true,
                bytes,
              },
              signal,
            );
          } catch (err) {
            if (err instanceof ExternalSourceDeclinedError) {
              await writeAudit(
                config,
                {
                  sessionId: session.sessionId,
                  agentId: session.agentId,
                  userOid: session.userOid,
                  projectId: metadata.projectId,
                  tool: "collab_create_proposal",
                  result: AuditResult.Failure,
                  intent,
                  type: "external_source_approval",
                  details: {
                    tool: "collab_create_proposal",
                    path: `proposals/<new>.md`,
                    outcome: AuditApprovalOutcome.Declined,
                    csrfTokenMatched: true,
                  },
                },
                signal,
              );
              return formatError("collab_create_proposal", err);
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
              tool: "collab_create_proposal",
              result: AuditResult.Success,
              intent,
              type: "external_source_approval",
              details: {
                tool: "collab_create_proposal",
                path: `proposals/<new>.md`,
                outcome: AuditApprovalOutcome.Approved,
                csrfTokenMatched: true,
              },
            },
            signal,
          );
        }

        // 4. Run the two-write proposal flow.
        const cTagBefore = liveAuthoritativeItem.cTag ?? null;
        let proposalResult;
        try {
          proposalResult = await runProposalWrite(
            {
              client,
              config,
              metadata,
              session,
              targetSectionSlug: targetSlug,
              targetSectionContentHashAtCreate: contentHashAtCreate,
              proposalBody: body,
              rationale: rationale ?? "",
              source,
              authoritativeCTag,
              liveAuthoritativeItem,
              liveAuthoritativeContent: liveContent,
            },
            signal,
          );
        } catch (err) {
          if (
            err instanceof CollabCTagMismatchError ||
            err instanceof MarkdownFileTooLargeError ||
            err instanceof ProposalIdCollisionError ||
            err instanceof DocIdRecoveryRequiredError
          ) {
            return formatError("collab_create_proposal", err);
          }
          throw err;
        }

        // 5. Persist counters + pin block updates (mirrors
        //    collab_write's bookkeeping).
        await config.sessionRegistry.incrementWrites(signal);
        await config.sessionRegistry.incrementSource(source, signal);
        await persistAuthoritativeMetadata(
          config,
          metadata,
          proposalResult.authoritativeUpdated,
          proposalResult.newDocId,
          signal,
        );

        // 6. §3.6 audit.
        const inputSummary: AuditInputSummary = {
          path: proposalResult.proposalItem.name,
          source: toAuditWriteSource(source),
          contentSizeBytes: bytes,
          sectionId: targetSlug,
          proposalId: proposalResult.proposalId,
        };
        if (rationale !== undefined && rationale.length > 0) {
          inputSummary.rationaleSizeBytes = Buffer.byteLength(rationale, "utf-8");
        }
        await writeAudit(
          config,
          {
            sessionId: session.sessionId,
            agentId: session.agentId,
            userOid: session.userOid,
            projectId: metadata.projectId,
            tool: "collab_create_proposal",
            result: AuditResult.Success,
            intent,
            type: "tool_call",
            details: {
              inputSummary,
              cTagBefore,
              cTagAfter: proposalResult.authoritativeUpdated.cTag ?? null,
              revisionAfter: proposalResult.authoritativeUpdated.version ?? null,
              bytes,
              source: toAuditWriteSource(source),
              resolvedItemId: proposalResult.proposalItem.id,
            },
          },
          signal,
        );

        const lines = [
          `proposalId: ${proposalResult.proposalId}`,
          `proposalFile: proposals/${proposalResult.proposalId}.md (${proposalResult.proposalItem.id})`,
          `targetSectionSlug: ${targetSlug}`,
          `targetSectionContentHashAtCreate: ${contentHashAtCreate}`,
          `bytes: ${proposalResult.proposalItem.size ?? bytes}`,
          `authoritativeCTag: ${proposalResult.authoritativeUpdated.cTag ?? "unknown"}`,
          proposalResult.authoritativeUpdated.version !== undefined
            ? `authoritativeRevision: ${proposalResult.authoritativeUpdated.version}`
            : "authoritativeRevision: (unknown)",
          `source: ${source}`,
        ];
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
        return formatError("collab_create_proposal", err);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// collab_apply_proposal
// ---------------------------------------------------------------------------

export function registerCollabApplyProposal(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
    server,
    COLLAB_APPLY_PROPOSAL_DEF,
    {
      inputSchema: {
        proposalId: z
          .string()
          .min(1)
          .describe(
            "ULID of the proposal to apply (matches a `collab.proposals[].id` " +
              "entry in the authoritative frontmatter, status: 'open').",
          ),
        authoritativeCTag: z
          .string()
          .min(1)
          .describe(
            "Opaque cTag for the authoritative file, from the most recent " +
              "collab_read. Required — the merge is a CAS write.",
          ),
        intent: z
          .string()
          .max(2048)
          .optional()
          .describe(
            "Free-text intent shown on the destructive re-prompt form (when " +
              "the apply would clobber another author's work).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ proposalId, authoritativeCTag, intent }, { signal }) => {
      try {
        const { session, metadata } = await requireActiveSession(config, signal);

        // Pre-flight write-budget check (mirrors collab_write — the
        // destructive-budget check fires later, after we know whether
        // the apply is destructive).
        if (session.writesUsed >= session.writeBudgetTotal) {
          return formatError(
            "collab_apply_proposal",
            new BudgetExhaustedError(session.writesUsed, session.writeBudgetTotal),
          );
        }

        const client = config.graphClient;

        // 1. Read the live authoritative file: needed to look up the
        //    proposal entry, locate the target section, and CAS-write
        //    the merged result.
        const authoritativeItemId = validateGraphId(
          "authoritativeItemId",
          metadata.pinnedAuthoritativeFileId,
        );
        const liveAuthoritativeItem = await getDriveItem(client, authoritativeItemId, signal);
        const liveContent = await getDriveItemContent(client, authoritativeItemId, signal);
        const liveSplit = splitFrontmatter(liveContent);
        const liveBody = liveSplit !== null ? liveSplit.body : liveContent;
        const liveRead = readMarkdownFrontmatter(liveContent);
        if (liveRead.kind !== "parsed") {
          // Frontmatter missing / malformed → no proposals[] to read.
          // Force the agent through collab_write first to recover the
          // envelope; we cannot apply a proposal against a stripped file.
          return formatError("collab_apply_proposal", new ProposalNotFoundError(proposalId));
        }
        const baseFrontmatter: CollabFrontmatter = liveRead.frontmatter;

        // 2. Look up the proposal entry in frontmatter.proposals[].
        const proposalEntry = baseFrontmatter.collab.proposals.find((p) => p.id === proposalId);
        if (proposalEntry === undefined) {
          return formatError("collab_apply_proposal", new ProposalNotFoundError(proposalId));
        }
        if (proposalEntry.status !== "open") {
          return formatError(
            "collab_apply_proposal",
            new ProposalAlreadyAppliedError(proposalId, proposalEntry.status),
          );
        }

        // 3. Read the proposal body file. The proposal entry's
        //    body_path is scope-relative under the project folder
        //    (typically `proposals/<id>.md`); resolve via the scope
        //    algorithm so a malicious cooperator cannot point
        //    body_path elsewhere.
        let proposalItem: DriveItem;
        try {
          proposalItem = await scopeCheckedResolve(
            config,
            metadata,
            proposalEntry.body_path,
            signal,
          );
        } catch (err) {
          if (err instanceof OutOfScopeError) {
            return formatError("collab_apply_proposal", err);
          }
          if (err instanceof GraphRequestError && err.statusCode === 404) {
            return formatError(
              "collab_apply_proposal",
              new FileNotFoundError(proposalEntry.body_path),
            );
          }
          throw err;
        }
        let proposalBody: string;
        try {
          proposalBody = await getDriveItemContent(
            client,
            validateGraphId("proposalItemId", proposalItem.id),
            signal,
          );
        } catch (err) {
          if (err instanceof MarkdownFileTooLargeError) {
            return formatError("collab_apply_proposal", err);
          }
          if (err instanceof GraphRequestError && err.statusCode === 404) {
            return formatError(
              "collab_apply_proposal",
              new FileNotFoundError(proposalEntry.body_path, proposalItem.id),
            );
          }
          throw err;
        }

        // 4. Locate the target section in the current authoritative
        //    body using the slug-first / hash-fallback algorithm
        //    (§2.3 step 2). The hash check uses the snapshot recorded
        //    at proposal create time, so a heading rename between
        //    create and apply is recovered automatically.
        const anchorResult = findSectionByAnchor(
          liveBody,
          proposalEntry.target_section_slug,
          proposalEntry.target_section_content_hash_at_create,
        );
        if (anchorResult.kind === "anchor_lost") {
          return formatError(
            "collab_apply_proposal",
            new SectionAnchorLostError(
              proposalId,
              proposalEntry.target_section_slug,
              proposalEntry.target_section_content_hash_at_create,
              anchorResult.currentSlugs,
            ),
          );
        }
        const targetSection = anchorResult.section;

        // 5. Audit `slug_drift_resolved` when the hash anchor saved us.
        if (anchorResult.kind === "slug_drift_resolved") {
          await writeAudit(
            config,
            {
              sessionId: session.sessionId,
              agentId: session.agentId,
              userOid: session.userOid,
              projectId: metadata.projectId,
              tool: "collab_apply_proposal",
              result: AuditResult.Success,
              type: "slug_drift_resolved",
              details: {
                proposalId,
                oldSlug: anchorResult.oldSlug,
                newSlug: anchorResult.newSlug,
                matchedBy: AuditMatchedBy.ContentHash,
              },
            },
            signal,
          );
        }

        // 6. Compute the current section's content hash and walk the
        //    authorship trail to detect destructive overwrites.
        const currentSectionBody = liveBody.slice(targetSection.bodyStart, targetSection.bodyEnd);
        const currentSectionHash = computeSectionContentHash(currentSectionBody);
        const classification = classifyAuthorshipMatch(
          baseFrontmatter.collab.authorship,
          targetSection.slug,
          currentSectionHash,
          session.agentId,
        );

        // 7. Destructive path: budget pre-check, then re-approval form.
        //    The diff is computed once and reused for both the form
        //    summary and the §3.6 `destructive_approval` audit.
        let diffText = "";
        if (classification.destructive) {
          if (session.destructiveUsed >= session.destructiveBudgetTotal) {
            return formatError(
              "collab_apply_proposal",
              new DestructiveBudgetExhaustedError(
                session.destructiveUsed,
                session.destructiveBudgetTotal,
              ),
            );
          }
          diffText = createTwoFilesPatch(
            `section:${targetSection.slug} (current)`,
            `section:${targetSection.slug} (proposed)`,
            currentSectionBody,
            proposalBody,
          );
          const priorAuthors = uniqueAuthorLabels(classification.matches.map((m) => m.entry));
          try {
            await runDestructiveReprompt(
              config,
              {
                tool: "collab_apply_proposal",
                proposalId,
                sectionSlug: targetSection.slug,
                diff: diffText,
                priorAuthors,
                intent,
                destructiveUsed: session.destructiveUsed,
                destructiveBudgetTotal: session.destructiveBudgetTotal,
              },
              signal,
            );
          } catch (err) {
            if (err instanceof DestructiveApprovalDeclinedError) {
              await writeAudit(
                config,
                {
                  sessionId: session.sessionId,
                  agentId: session.agentId,
                  userOid: session.userOid,
                  projectId: metadata.projectId,
                  tool: "collab_apply_proposal",
                  result: AuditResult.Failure,
                  intent,
                  type: "destructive_approval",
                  details: {
                    tool: "collab_apply_proposal",
                    outcome: AuditApprovalOutcome.Declined,
                    diffSummaryHash: hashDiffSummary(diffText),
                    csrfTokenMatched: true,
                  },
                },
                signal,
              );
              return formatError("collab_apply_proposal", err);
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
              tool: "collab_apply_proposal",
              result: AuditResult.Success,
              intent,
              type: "destructive_approval",
              details: {
                tool: "collab_apply_proposal",
                outcome: AuditApprovalOutcome.Approved,
                diffSummaryHash: hashDiffSummary(diffText),
                csrfTokenMatched: true,
              },
            },
            signal,
          );
        }

        // 8. Build the merged authoritative body: replace the target
        //    section's body with the proposal body, leaving the
        //    heading line and the rest of the file intact.
        const newBody =
          liveBody.slice(0, targetSection.bodyStart) +
          proposalBody +
          liveBody.slice(targetSection.bodyEnd);

        // 9. Compute the post-merge content hash (the section body is
        //    now exactly the proposal body — the heading line stays,
        //    and the next equal-or-higher heading is unchanged).
        const newSectionContentHash = computeSectionContentHash(proposalBody);

        // 10. Append a fresh authorship[] entry and mark the proposal
        //     as applied. The new revision number is the live
        //     revision + 1 (best-effort — the actual server revision
        //     is the cTag suffix; we record a monotonically-increasing
        //     index so the trail can be re-ordered locally).
        const now = nowFactory(config)();
        const newAuthorship: CollabFrontmatter["collab"]["authorship"][number] = {
          target_section_slug: targetSection.slug,
          section_content_hash: newSectionContentHash,
          author_kind: "agent",
          author_agent_id: session.agentId,
          author_display_name: session.agentId,
          written_at: now.toISOString(),
          revision: extractRevisionFromCTag(liveAuthoritativeItem.cTag) + 1,
        };
        const nextProposals = baseFrontmatter.collab.proposals.map((p) =>
          p.id === proposalId ? { ...p, status: "applied" as const } : p,
        );
        const nextFrontmatter: CollabFrontmatter = {
          collab: {
            ...baseFrontmatter.collab,
            proposals: nextProposals,
            authorship: [...baseFrontmatter.collab.authorship, newAuthorship],
          },
        };
        const yaml = serializeFrontmatter(nextFrontmatter);
        const newContent = joinFrontmatter(yaml, newBody);

        // 11. CAS-write the authoritative file.
        const cTagBefore = liveAuthoritativeItem.cTag ?? null;
        let updated: DriveItem;
        try {
          updated = await writeAuthoritative(
            client,
            authoritativeItemId,
            authoritativeCTag,
            newContent,
            signal,
          );
        } catch (err) {
          if (err instanceof CollabCTagMismatchError || err instanceof MarkdownFileTooLargeError) {
            return formatError("collab_apply_proposal", err);
          }
          throw err;
        }

        // 12. Counters: writes always; destructive only when classified.
        await config.sessionRegistry.incrementWrites(signal);
        if (classification.destructive) {
          await config.sessionRegistry.incrementDestructive(signal);
        }

        // 13. Persist pin block (new cTag/revision; doc_id is
        //     unchanged but we re-write it for cache freshness).
        await persistAuthoritativeMetadata(
          config,
          metadata,
          updated,
          nextFrontmatter.collab.doc_id,
          signal,
        );

        // 14. §3.6 tool_call audit.
        const inputSummary: AuditInputSummary = {
          path: liveAuthoritativeItem.name,
          sectionId: targetSection.slug,
          proposalId,
        };
        await writeAudit(
          config,
          {
            sessionId: session.sessionId,
            agentId: session.agentId,
            userOid: session.userOid,
            projectId: metadata.projectId,
            tool: "collab_apply_proposal",
            result: AuditResult.Success,
            intent,
            type: "tool_call",
            details: {
              inputSummary,
              cTagBefore,
              cTagAfter: updated.cTag ?? null,
              revisionAfter: updated.version ?? null,
              resolvedItemId: updated.id,
            },
          },
          signal,
        );

        // 15. Compose the agent-facing output.
        const lines = [
          `applied: proposal ${proposalId}`,
          `targetSectionSlug: ${targetSection.slug}`,
          `destructive: ${classification.destructive ? "true" : "false"}`,
          `slugDriftResolved: ${anchorResult.kind === "slug_drift_resolved" ? "true" : "false"}`,
          `cTag: ${updated.cTag ?? "unknown"}`,
          updated.version !== undefined ? `revision: ${updated.version}` : "revision: (unknown)",
          `bytes: ${updated.size ?? Buffer.byteLength(newContent, "utf-8")}`,
        ];
        if (anchorResult.kind === "slug_drift_resolved") {
          lines.push(`oldSlug: ${anchorResult.oldSlug}`);
          lines.push(`newSlug: ${anchorResult.newSlug}`);
        }
        const refreshed = config.sessionRegistry.snapshot();
        if (refreshed !== null) {
          lines.push(`writes: ${refreshed.writesUsed} / ${refreshed.writeBudgetTotal}`);
          if (classification.destructive) {
            lines.push(
              `destructive: ${refreshed.destructiveUsed} / ${refreshed.destructiveBudgetTotal}`,
            );
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return formatError("collab_apply_proposal", err);
      }
    },
  );
}
