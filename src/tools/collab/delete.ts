// `collab_delete_file` MCP tool registration (W5 Day 2).
//
// Wraps `DELETE /me/drive/items/{id}` for a file inside the active
// project's scope. Always destructive per `docs/plans/collab-v1.md`
// §2.3: every call opens the §5.2.3 re-approval form (via the W0
// form-factory slot surfaced by {@link runDestructiveReprompt}) and,
// on approve, decrements **both** the write and the destructive-
// approval budget.
//
// Hard refusals (never reach the browser form):
//
//   - The project's pinned authoritative `.md` file — the file is
//     the project's identity. Raised as
//     {@link RefuseDeleteAuthoritativeError}.
//   - Anything inside `.collab/` (the sentinel folder). The §4.6
//     scope resolver already refuses dot-prefixed segments, so this
//     is belt-and-braces: any request that mentions `.collab` in its
//     path (pre-resolution) raises
//     {@link RefuseDeleteSentinelError} directly.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  AuthenticationRequiredError,
  BudgetExhaustedError,
  DestructiveApprovalDeclinedError,
  DestructiveBudgetExhaustedError,
  OutOfScopeError,
} from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";
import { defineTool } from "../../tool-registry.js";
import { GraphClient, GraphRequestError } from "../../graph/client.js";
import { validateGraphId } from "../../graph/ids.js";
import { deleteDriveItem } from "../../graph/markdown.js";
import {
  AuditApprovalOutcome,
  AuditResult,
  hashDiffSummary,
  writeAudit,
} from "../../collab/audit.js";
import { formatError } from "../shared.js";

import { runDestructiveReprompt } from "./ops.js";
import {
  COLLAB_DELETE_FILE_DEF,
  FileNotFoundError,
  RefuseDeleteAuthoritativeError,
  RefuseDeleteSentinelError,
  SENTINEL_FOLDER_NAME,
  requireActiveSession,
  scopeCheckedResolve,
} from "./shared.js";

/**
 * Pre-resolution check: refuse any path whose normalised form
 * references the `.collab/` sentinel folder.  Keeps the refusal
 * deterministic (no Graph round-trip) and ensures the error surfaces
 * as {@link RefuseDeleteSentinelError} rather than a generic
 * `OutOfScopeError` from the scope resolver.
 */
function pathMentionsSentinel(path: string): boolean {
  // Trim leading/trailing slashes, lowercase for case-insensitive
  // comparison with the OneDrive segment matcher, split on `/`.
  const segments = path
    .replace(/^[/\\]+/, "")
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/);
  return segments.some((s) => s.toLowerCase() === SENTINEL_FOLDER_NAME);
}

export function registerCollabDeleteFile(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
    server,
    COLLAB_DELETE_FILE_DEF,
    {
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Scope-relative path to delete — `proposals/<...>.md`, " +
              "`drafts/<...>.md`, `attachments/<...>`. The authoritative " +
              "`.md` file and anything under `.collab/` are always refused.",
          ),
        intent: z
          .string()
          .max(2048)
          .optional()
          .describe("Free-text intent shown in the destructive re-prompt form."),
      },
      annotations: {
        title: COLLAB_DELETE_FILE_DEF.title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, intent }, { signal }) => {
      try {
        const { session, metadata } = await requireActiveSession(config, signal);

        // Pre-resolution refusal for `.collab/` — belt-and-braces
        // against any future scope-resolver change; keeps the
        // typed-error surface clean.
        if (pathMentionsSentinel(path)) {
          return formatError("collab_delete_file", new RefuseDeleteSentinelError(path));
        }

        // Pre-flight both budgets so a stale caller never opens a
        // browser tab that could never be honoured.
        if (session.writesUsed >= session.writeBudgetTotal) {
          return formatError(
            "collab_delete_file",
            new BudgetExhaustedError(session.writesUsed, session.writeBudgetTotal),
          );
        }
        if (session.destructiveUsed >= session.destructiveBudgetTotal) {
          return formatError(
            "collab_delete_file",
            new DestructiveBudgetExhaustedError(
              session.destructiveUsed,
              session.destructiveBudgetTotal,
            ),
          );
        }

        let item;
        try {
          item = await scopeCheckedResolve(config, metadata, path, signal);
        } catch (err) {
          if (err instanceof OutOfScopeError) {
            return formatError("collab_delete_file", err);
          }
          if (err instanceof GraphRequestError && err.statusCode === 404) {
            return formatError("collab_delete_file", new FileNotFoundError(path));
          }
          throw err;
        }

        if (item.id === metadata.pinnedAuthoritativeFileId) {
          return formatError("collab_delete_file", new RefuseDeleteAuthoritativeError(path));
        }

        // The re-prompt form needs a cheap text summary — we do not
        // download the file content (could be a multi-MiB
        // attachment). The diffSummaryHash is derived from the same
        // summary so post-hoc reviewers can correlate the audited
        // approval with the rendered form without storing any file
        // bytes in the audit log.
        const summaryLines = [
          `path: ${path}`,
          `name: ${item.name}`,
          `itemId: ${item.id}`,
          `size: ${item.size ?? "unknown"} bytes`,
          `modified: ${item.lastModifiedDateTime ?? "unknown"}`,
        ];
        const diffSummary = summaryLines.join("\n");

        try {
          await runDestructiveReprompt(
            config,
            {
              tool: "collab_delete_file",
              proposalId: path,
              sectionSlug: `delete:${path}`,
              diff: diffSummary,
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
                tool: "collab_delete_file",
                result: AuditResult.Failure,
                intent,
                type: "destructive_approval",
                details: {
                  tool: "collab_delete_file",
                  outcome: AuditApprovalOutcome.Declined,
                  diffSummaryHash: hashDiffSummary(diffSummary),
                  csrfTokenMatched: true,
                },
              },
              signal,
            );
            return formatError("collab_delete_file", err);
          }
          throw err;
        }

        // Approved — audit the approval, issue the delete, increment
        // counters, write the tool_call envelope.
        await writeAudit(
          config,
          {
            sessionId: session.sessionId,
            agentId: session.agentId,
            userOid: session.userOid,
            projectId: metadata.projectId,
            tool: "collab_delete_file",
            result: AuditResult.Success,
            intent,
            type: "destructive_approval",
            details: {
              tool: "collab_delete_file",
              outcome: AuditApprovalOutcome.Approved,
              diffSummaryHash: hashDiffSummary(diffSummary),
              csrfTokenMatched: true,
            },
          },
          signal,
        );

        const token = await config.authenticator.token(signal);
        const client = new GraphClient(config.graphBaseUrl, {
          getToken: () => Promise.resolve(token),
        });

        const validatedItemId = validateGraphId("resolvedItemId", item.id);
        try {
          await deleteDriveItem(client, validatedItemId, signal);
        } catch (err) {
          if (err instanceof GraphRequestError && err.statusCode === 404) {
            return formatError("collab_delete_file", new FileNotFoundError(path, item.id));
          }
          throw err;
        }

        await config.sessionRegistry.incrementWrites(signal);
        await config.sessionRegistry.incrementDestructive(signal);

        await writeAudit(
          config,
          {
            sessionId: session.sessionId,
            agentId: session.agentId,
            userOid: session.userOid,
            projectId: metadata.projectId,
            tool: "collab_delete_file",
            result: AuditResult.Success,
            intent,
            type: "tool_call",
            details: {
              inputSummary: { path },
              resolvedItemId: item.id,
            },
          },
          signal,
        );

        const refreshed = config.sessionRegistry.snapshot();
        const outLines = [`deleted: ${item.name} (${item.id})`, `path: ${path}`];
        if (refreshed !== null) {
          outLines.push(`writes: ${refreshed.writesUsed} / ${refreshed.writeBudgetTotal}`);
          outLines.push(
            `destructive approvals: ${refreshed.destructiveUsed} / ${refreshed.destructiveBudgetTotal}`,
          );
        }
        return { content: [{ type: "text", text: outLines.join("\n") }] };
      } catch (err) {
        if (err instanceof AuthenticationRequiredError) {
          return formatError("collab_delete_file", err);
        }
        return formatError("collab_delete_file", err);
      }
    },
  );
}
