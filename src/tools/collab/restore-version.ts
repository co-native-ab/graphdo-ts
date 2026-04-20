// `collab_restore_version` MCP tool registration (W5 Day 1).
//
// Wraps `POST /me/drive/items/{itemId}/versions/{versionId}/restoreVersion`
// for any file in the active project's scope. Always counts as 1
// write toward the session budget. When the target is the
// authoritative file the restore is destructive: a §5.2 re-approval
// form is opened with a unified diff between the current and the
// target revision, and on approve the destructive-approval budget is
// decremented. The destructive case also requires
// `authoritativeCTag` for optimistic-concurrency safety — a stale
// cTag raises {@link CollabCTagMismatchError} **before** the restore
// is issued so the agent never destroys a write it has not seen.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import {
  AuthenticationRequiredError,
  BudgetExhaustedError,
  CollabCTagMismatchError,
  DestructiveApprovalDeclinedError,
  DestructiveBudgetExhaustedError,
  OutOfScopeError,
} from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";
import { defineTool } from "../../tool-registry.js";
import { GraphClient, GraphRequestError } from "../../graph/client.js";
import { validateGraphId } from "../../graph/ids.js";
import {
  MarkdownFileTooLargeError,
  MarkdownUnknownVersionError,
  downloadDriveItemVersionContent,
  downloadMarkdownContent,
  listDriveItemVersions,
  restoreDriveItemVersion,
} from "../../graph/markdown.js";
import { getDriveItem } from "../../collab/graph.js";
import {
  AuditApprovalOutcome,
  AuditResult,
  hashDiffSummary,
  writeAudit,
} from "../../collab/audit.js";
import { formatError } from "../shared.js";

import { runDestructiveReprompt } from "./ops.js";
import {
  COLLAB_RESTORE_VERSION_DEF,
  FileNotFoundError,
  requireActiveSession,
  resolveTargetItem,
} from "./shared.js";

export function registerCollabRestoreVersion(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
    server,
    COLLAB_RESTORE_VERSION_DEF,
    {
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Scope-relative path. Defaults to the authoritative file when " +
              "both `path` and `itemId` are omitted.",
          ),
        itemId: z.string().optional().describe("Drive item ID (alternative to `path`)."),
        versionId: z.string().min(1).describe("Opaque versionId returned by collab_list_versions."),
        authoritativeCTag: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Required when restoring the authoritative file. Re-read with " +
              "collab_read to fetch the current cTag.",
          ),
        intent: z
          .string()
          .max(2048)
          .optional()
          .describe("Free-text intent shown in the destructive re-prompt form."),
      },
      annotations: {
        title: COLLAB_RESTORE_VERSION_DEF.title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, itemId, versionId, authoritativeCTag, intent }, { signal }) => {
      try {
        const { session, metadata } = await requireActiveSession(config, signal);

        // Pre-flight write budget — restoreVersion always counts as 1
        // write regardless of whether the destructive path fires.
        if (session.writesUsed >= session.writeBudgetTotal) {
          return formatError(
            "collab_restore_version",
            new BudgetExhaustedError(session.writesUsed, session.writeBudgetTotal),
          );
        }

        let resolved;
        try {
          resolved = await resolveTargetItem(config, metadata, { path, itemId }, signal);
        } catch (err) {
          if (err instanceof OutOfScopeError) {
            return formatError("collab_restore_version", err);
          }
          if (err instanceof GraphRequestError && err.statusCode === 404) {
            return formatError(
              "collab_restore_version",
              new FileNotFoundError(path ?? `itemId:${itemId ?? ""}`),
            );
          }
          throw err;
        }

        const item = resolved.item;
        const isAuthoritative = resolved.isAuthoritative;

        if (
          isAuthoritative &&
          (authoritativeCTag === undefined || authoritativeCTag.length === 0)
        ) {
          return formatError(
            "collab_restore_version",
            new Error(
              "authoritativeCTag is required when restoring the authoritative file. " +
                "Re-read with collab_read to fetch the current cTag.",
            ),
          );
        }

        const token = await config.authenticator.token(signal);
        const client = new GraphClient(config.graphBaseUrl, {
          getToken: () => Promise.resolve(token),
        });

        const validatedItemId = validateGraphId("resolvedItemId", item.id);
        const validatedVersionId = validateGraphId("versionId", versionId);

        // Pre-flight cTag check on authoritative restore so a stale
        // pin surfaces *before* any browser tab opens. The check is
        // intentionally cheap — we already have `item` from the
        // resolve step.
        if (isAuthoritative && item.cTag !== authoritativeCTag) {
          return formatError(
            "collab_restore_version",
            new CollabCTagMismatchError(
              validatedItemId,
              authoritativeCTag ?? "",
              item.cTag,
              item.version,
              item,
            ),
          );
        }

        // Build the diff between current content and the target
        // revision. Used both for the destructive re-prompt summary
        // and for the §3.6 audit's diffSummaryHash. We compute it
        // even on non-authoritative restores so the success message
        // can include a one-line summary.
        let currentContent = "";
        let targetContent = "";
        try {
          // Validate the versionId exists for this file before
          // touching anything else, so a typo surfaces as
          // MarkdownUnknownVersionError rather than as a Graph 404
          // halfway through the diff fetch.
          const versions = await listDriveItemVersions(client, validatedItemId, signal);
          const known = versions.map((v) => v.id);
          if (!known.includes(versionId)) {
            return formatError(
              "collab_restore_version",
              new MarkdownUnknownVersionError(item.id, versionId, known),
            );
          }
          const [cur, tgt] = await Promise.all([
            downloadMarkdownContent(client, validatedItemId, signal),
            // The /versions list returns the current version as its
            // first entry; OneDrive rejects the content endpoint for
            // it (HTTP 400). Short-circuit: when the caller targets
            // the current revision, target == current.
            versionId === versions[0]?.id
              ? Promise.resolve(undefined)
              : downloadDriveItemVersionContent(
                  client,
                  validatedItemId,
                  validatedVersionId,
                  signal,
                ),
          ]);
          currentContent = cur;
          targetContent = tgt ?? cur;
        } catch (err) {
          if (err instanceof MarkdownFileTooLargeError) {
            return formatError("collab_restore_version", err);
          }
          throw err;
        }

        const diffText = createTwoFilesPatch(
          `${item.name}@current`,
          `${item.name}@${versionId}`,
          currentContent,
          targetContent,
          undefined,
          undefined,
          { context: 3 },
        );

        if (currentContent === targetContent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Nothing to restore: version ${versionId} of ${item.name} ` +
                  "matches the current content byte-for-byte.",
              },
            ],
          };
        }

        // Destructive re-prompt for authoritative restores. The form
        // surfaces the diff plus the destructive-budget counters per
        // §5.2; on cancel we audit the declined approval and refuse.
        if (isAuthoritative) {
          if (session.destructiveUsed >= session.destructiveBudgetTotal) {
            return formatError(
              "collab_restore_version",
              new DestructiveBudgetExhaustedError(
                session.destructiveUsed,
                session.destructiveBudgetTotal,
              ),
            );
          }
          try {
            await runDestructiveReprompt(
              config,
              {
                tool: "collab_restore_version",
                proposalId: versionId,
                sectionSlug: `restore:${versionId}`,
                diff: diffText,
                priorAuthors: [],
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
                  tool: "collab_restore_version",
                  result: AuditResult.Failure,
                  intent,
                  type: "destructive_approval",
                  details: {
                    tool: "collab_restore_version",
                    outcome: AuditApprovalOutcome.Declined,
                    diffSummaryHash: hashDiffSummary(diffText),
                    csrfTokenMatched: true,
                  },
                },
                signal,
              );
              return formatError("collab_restore_version", err);
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
              tool: "collab_restore_version",
              result: AuditResult.Success,
              intent,
              type: "destructive_approval",
              details: {
                tool: "collab_restore_version",
                outcome: AuditApprovalOutcome.Approved,
                diffSummaryHash: hashDiffSummary(diffText),
                csrfTokenMatched: true,
              },
            },
            signal,
          );
        }

        // Issue the restore.
        try {
          await restoreDriveItemVersion(client, validatedItemId, validatedVersionId, signal);
        } catch (err) {
          if (err instanceof GraphRequestError && err.statusCode === 404) {
            return formatError(
              "collab_restore_version",
              new MarkdownUnknownVersionError(item.id, versionId, []),
            );
          }
          throw err;
        }

        // Re-fetch the item to surface the fresh cTag/revision.
        const updated = await getDriveItem(client, validatedItemId, signal);

        // Counters: writes always; destructive only when authoritative.
        await config.sessionRegistry.incrementWrites(signal);
        if (isAuthoritative) {
          await config.sessionRegistry.incrementDestructive(signal);
        }

        // §3.6 audit: tool_call envelope mirroring the collab_write
        // shape so post-hoc reviewers can correlate restores with
        // ordinary writes.
        await writeAudit(
          config,
          {
            sessionId: session.sessionId,
            agentId: session.agentId,
            userOid: session.userOid,
            projectId: metadata.projectId,
            tool: "collab_restore_version",
            result: AuditResult.Success,
            intent,
            type: "tool_call",
            details: {
              inputSummary: {
                path: path ?? `itemId:${item.id}`,
                ...(isAuthoritative ? {} : {}),
              },
              cTagBefore: item.cTag ?? null,
              cTagAfter: updated.cTag ?? null,
              revisionAfter: updated.version ?? null,
              ...(updated.size !== undefined ? { bytes: updated.size } : {}),
              resolvedItemId: updated.id,
            },
          },
          signal,
        );

        const refreshed = config.sessionRegistry.snapshot();
        const lines = [
          `restored: ${updated.name} (${updated.id})`,
          `to versionId: ${versionId}`,
          `cTag: ${updated.cTag ?? "unknown"}`,
          updated.version !== undefined ? `revision: ${updated.version}` : "revision: (unknown)",
          `isAuthoritative: ${isAuthoritative ? "true" : "false"}`,
        ];
        if (refreshed !== null) {
          lines.push(`writes: ${refreshed.writesUsed} / ${refreshed.writeBudgetTotal}`);
          if (isAuthoritative) {
            lines.push(
              `destructive approvals: ${refreshed.destructiveUsed} / ${refreshed.destructiveBudgetTotal}`,
            );
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err instanceof AuthenticationRequiredError) {
          return formatError("collab_restore_version", err);
        }
        return formatError("collab_restore_version", err);
      }
    },
  );
}
