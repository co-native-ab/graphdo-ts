// Heavy-weight orchestration helpers for the collab tools — extracted
// from `./shared.ts` to keep that module under the W4 buffer DoD's
// per-file LOC cap. Pure code-organisation; no behaviour change.
//
// This module owns:
//   - The two browser re-prompt forms ({@link runExternalSourceReprompt},
//     {@link runDestructiveReprompt}).
//   - The §3.1 doc_id resolution helpers + the authoritative-write
//     orchestrator ({@link resolveAuthoritativeFrontmatter},
//     {@link runAuthoritativeWrite}, {@link persistAuthoritativeMetadata},
//     {@link buildFreshCollabFrontmatter}, {@link parseYamlForFrontmatter},
//     {@link DocIdSource}).
//   - The two-write proposal helper ({@link runProposalWrite}) shared by
//     `collab_write conflictMode='proposal'` and the standalone
//     `collab_create_proposal` tool.

import { parse as yamlParseRaw } from "yaml";

import {
  DestructiveApprovalDeclinedError,
  DocIdRecoveryRequiredError,
  ExternalSourceDeclinedError,
  ProposalIdCollisionError,
  UserCancelledError,
} from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import { logger } from "../../logger.js";
import { GraphClient } from "../../graph/client.js";
import { validateGraphId } from "../../graph/ids.js";
import type { DriveItem } from "../../graph/types.js";
import { newUlid } from "../../collab/ulid.js";
import { saveProjectMetadata } from "../../collab/projects.js";
import {
  COLLAB_CONTENT_TYPE_MARKDOWN,
  ProjectFileAlreadyExistsError,
  getDriveItemContent,
  writeAuthoritative,
  writeProjectFile,
  type WriteProjectFileTarget,
} from "../../collab/graph.js";
import {
  CollabFrontmatterSchema,
  joinFrontmatter,
  readMarkdownFrontmatter,
  serializeFrontmatter,
  splitFrontmatter,
  type CollabFrontmatter,
  type FrontmatterResetAudit,
} from "../../collab/frontmatter.js";
import { startBrowserPicker } from "../../picker.js";
import { acquireFormSlot } from "../collab-forms.js";

import { nowFactory } from "../shared.js";
import {
  PROPOSALS_FOLDER_NAME,
  PROPOSAL_ID_RETRY_LIMIT,
  ensureParentFolder,
  type ProjectMetadata,
  type SessionSnapshot,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Re-prompt forms
// ---------------------------------------------------------------------------

/**
 * Open the §5.2.4 external-source re-approval form. Acquires the
 * single-in-flight form-factory slot for the duration; resolves on
 * approve, throws {@link ExternalSourceDeclinedError} on cancel /
 * timeout / browser close.
 */
export async function runExternalSourceReprompt(
  config: ServerConfig,
  args: {
    path: string;
    intent: string | undefined;
    sourceCounters: { external: number };
    isCreate: boolean;
    bytes: number;
  },
  signal: AbortSignal,
): Promise<void> {
  const slot = acquireFormSlot("collab_write_external");
  try {
    const summaryLines = [
      `path: ${args.path}`,
      `intent: ${args.intent ?? "(not provided)"}`,
      `kind: ${args.isCreate ? "first write (new file)" : "update existing file"}`,
      `bytes: ${args.bytes}`,
      `external-source writes used this session: ${args.sourceCounters.external}`,
    ];
    const handle = await startBrowserPicker(
      {
        title: "Approve External-Source Write",
        subtitle:
          "An MCP tool wants to write content that did NOT come from this " +
          "chat or from a prior `collab_read`. Click Approve to allow the " +
          "write, or Cancel to refuse it.\n\n" +
          summaryLines.join("\n"),
        options: [{ id: "approve", label: "Approve external-source write" }],
        onSelect: async () => {
          // Approval is recorded by the tool layer once the picker
          // resolves; nothing to do here.
        },
      },
      signal,
    );
    slot.setUrl(handle.url);
    let browserOpened = false;
    try {
      await config.openBrowser(handle.url);
      browserOpened = true;
    } catch (err: unknown) {
      logger.warn("could not open browser for external-source re-prompt", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!browserOpened) {
      logger.info("external-source re-prompt awaiting manual visit", { url: handle.url });
    }

    try {
      await handle.waitForSelection;
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) {
        throw new ExternalSourceDeclinedError(args.path);
      }
      throw err;
    }
  } finally {
    slot.release();
  }
}

/**
 * Open the §5.2.3 destructive re-approval form. Acquires the
 * single-in-flight form-factory slot for the duration; resolves on
 * approve, throws {@link DestructiveApprovalDeclinedError} on cancel /
 * timeout / browser close.
 *
 * The form shows a unified diff of the section that would be replaced
 * (current vs. proposed), the list of prior authors that triggered the
 * destructive classification, and the destructive-budget counters so
 * the human can decide whether to approve.
 */
export async function runDestructiveReprompt(
  config: ServerConfig,
  args: {
    tool: string;
    proposalId: string;
    sectionSlug: string;
    diff: string;
    priorAuthors: readonly string[];
    intent: string | undefined;
    destructiveUsed: number;
    destructiveBudgetTotal: number;
  },
  signal: AbortSignal,
): Promise<void> {
  const slot = acquireFormSlot("collab_apply_proposal_destructive");
  try {
    const authorList =
      args.priorAuthors.length === 0 ? "(none recorded)" : args.priorAuthors.join(", ");
    const summaryLines = [
      `tool: ${args.tool}`,
      `proposalId: ${args.proposalId}`,
      `targetSectionSlug: ${args.sectionSlug}`,
      `intent: ${args.intent ?? "(not provided)"}`,
      `prior authors: ${authorList}`,
      `destructive operations used this session: ${args.destructiveUsed} / ${args.destructiveBudgetTotal}`,
      ``,
      `--- diff ---`,
      args.diff,
    ];
    const handle = await startBrowserPicker(
      {
        title: "Approve Destructive Apply",
        subtitle:
          "An MCP tool wants to overwrite a section that was last " +
          "edited by a human or a different agent. Click Approve to " +
          "allow the apply, or Cancel to refuse it.\n\n" +
          summaryLines.join("\n"),
        options: [{ id: "approve", label: "Approve destructive apply" }],
        onSelect: async () => {
          // Approval is recorded by the tool layer once the picker
          // resolves; nothing to do here.
        },
      },
      signal,
    );
    slot.setUrl(handle.url);
    let browserOpened = false;
    try {
      await config.openBrowser(handle.url);
      browserOpened = true;
    } catch (err: unknown) {
      logger.warn("could not open browser for destructive re-prompt", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!browserOpened) {
      logger.info("destructive re-prompt awaiting manual visit", { url: handle.url });
    }

    try {
      await handle.waitForSelection;
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) {
        throw new DestructiveApprovalDeclinedError(args.tool, args.sectionSlug);
      }
      throw err;
    }
  } finally {
    slot.release();
  }
}

// ---------------------------------------------------------------------------
// Authoritative-write helpers
// ---------------------------------------------------------------------------

/**
 * Where the `doc_id` for an authoritative write came from. Returned by
 * {@link resolveAuthoritativeFrontmatter} so the W3 Day 3 audit writer
 * can record the recovery path that fired (parsed → no audit, anything
 * else → `frontmatter_reset` audit entry with `recoveredDocId: true`
 * for `Cache` / `Live` / `Fresh`).
 *
 * A real enum (vs. a string union) keeps the comparator readable and
 * matches the codebase convention set by GraphScope, HttpMethod,
 * MarkdownFolderEntryKind.
 */
export enum DocIdSource {
  /** Agent supplied a parseable `collab:` frontmatter envelope. */
  Agent = "agent",
  /** Live file's frontmatter parsed cleanly. */
  Live = "live",
  /** Live frontmatter was missing/malformed; recovered from local pin block. */
  Cache = "cache",
  /** No agent / live / cache value — fresh ULID minted (originator first-write). */
  Fresh = "fresh",
}

/**
 * Pick (or mint) the canonical {@link CollabFrontmatter} block for a
 * write to the authoritative file. Encodes the §3.1 doc_id stability
 * rules:
 *
 * - Agent-supplied content already carries parseable frontmatter →
 *   that frontmatter wins. Validates against the schema; a malformed
 *   inner block falls through to the recovery path so the agent can
 *   never sneak past the schema by attaching a broken envelope.
 * - Otherwise look at the file's current live frontmatter:
 *   - parses → reuse `{doc_id, created_at}` and reset the lists.
 *   - reset (missing/malformed) → fall through to local cache.
 * - Otherwise local cache `docId` is non-null → reuse it,
 *   `created_at` defaults to `now()`.
 * - Otherwise → throw {@link DocIdRecoveryRequiredError} so the agent
 *   is directed at `session_recover_doc_id` (W5 Day 1).
 *
 * The returned `body` is the markdown body the caller should join the
 * canonical frontmatter back onto (always LF-normalised).
 *
 * Note: this milestone (W3 Day 2) does not preserve the
 * `sections`/`proposals`/`authorship` collections when the agent
 * supplied content without a frontmatter envelope — those fields
 * default to empty arrays. The fields are still preserved when the
 * agent's own frontmatter carries them. Section-aware writes land with
 * `collab_acquire_section` / `collab_create_proposal` in W3 Day 4 + W4.
 */
export function resolveAuthoritativeFrontmatter(args: {
  agentContent: string;
  liveContent: string;
  cachedDocId: string | null;
  projectId: string;
  now: () => Date;
}): {
  frontmatter: CollabFrontmatter;
  body: string;
  docIdSource: DocIdSource;
} {
  const split = splitFrontmatter(args.agentContent);
  if (split !== null) {
    const parseAttempt = CollabFrontmatterSchema.safeParse(parseYamlForFrontmatter(split.yaml));
    if (parseAttempt.success) {
      return {
        frontmatter: parseAttempt.data,
        body: split.body,
        docIdSource: DocIdSource.Agent,
      };
    }
    // Fall through — agent's envelope was unparseable; treat the body
    // alone as the new content and recover the doc_id from elsewhere.
    logger.warn("agent supplied unparseable frontmatter; falling back to recovery", {
      error: parseAttempt.error.message,
    });
  }
  const body = split !== null ? split.body : args.agentContent.replace(/\r\n/g, "\n");

  const liveRead = readMarkdownFrontmatter(args.liveContent);
  if (liveRead.kind === "parsed") {
    return {
      frontmatter: {
        collab: {
          version: liveRead.frontmatter.collab.version,
          doc_id: liveRead.frontmatter.collab.doc_id,
          created_at: liveRead.frontmatter.collab.created_at,
          sections: [],
          proposals: [],
          authorship: [],
        },
      },
      body,
      docIdSource: DocIdSource.Live,
    };
  }

  if (args.cachedDocId !== null) {
    return {
      frontmatter: buildFreshCollabFrontmatter(args.cachedDocId, args.now()),
      body,
      docIdSource: DocIdSource.Cache,
    };
  }

  // Originator's first write to a brand-new project: mint a fresh
  // doc_id and persist it so subsequent writes resolve via cache.
  // The §10 row-04 "fresh machine + wiped frontmatter + wiped cache"
  // variant is differentiated by the presence of /versions history
  // and is handled by `session_recover_doc_id` (W5 Day 1) — the
  // helper above always treats no-history as first-write here.
  const freshDocId = newUlid(() => args.now().getTime());
  return {
    frontmatter: buildFreshCollabFrontmatter(freshDocId, args.now()),
    body,
    docIdSource: DocIdSource.Fresh,
  };
}

/**
 * Mint a fresh canonical {@link CollabFrontmatter} for a brand-new
 * doc_id. Used by the recovery path and by first-write where neither
 * the agent nor the live file carry one.
 */
export function buildFreshCollabFrontmatter(docId: string, now: Date): CollabFrontmatter {
  return {
    collab: {
      version: 1,
      doc_id: docId,
      created_at: now.toISOString(),
      sections: [],
      proposals: [],
      authorship: [],
    },
  };
}

/**
 * Lightweight YAML parse for the agent-supplied frontmatter envelope.
 * Returns `null` (so {@link CollabFrontmatterSchema.safeParse} fails)
 * when the YAML cannot be parsed at all. The hardened parser used by
 * `readMarkdownFrontmatter` is too strict for this path — it throws on
 * malformed input — and we want to silently recover instead of
 * surfacing a noisy parse error to the agent.
 */
export function parseYamlForFrontmatter(yamlBody: string): unknown {
  try {
    return yamlParseRaw(yamlBody);
  } catch {
    return null;
  }
}

/**
 * Execute the authoritative-file write path: fetch the live content
 * (so we can recover `doc_id` / `created_at` if the agent's content
 * lacks frontmatter), build the canonical frontmatter envelope per
 * §3.1, and CAS-write via {@link writeAuthoritative}. Returns the
 * updated DriveItem so the caller can record the new cTag/revision.
 *
 * The local cache `docId` (when non-null) is the authoritative source
 * for recovery; the live file is consulted only as a secondary path
 * (the cache is updated on every successful write so it should never
 * be more stale than one write old).
 */
export async function runAuthoritativeWrite(
  config: ServerConfig,
  client: GraphClient,
  metadata: ProjectMetadata,
  resolvedItem: DriveItem,
  cTag: string,
  agentContent: string,
  signal: AbortSignal,
): Promise<{
  updated: DriveItem;
  writtenDocId: string;
  frontmatterReset: FrontmatterResetAudit | null;
}> {
  const validatedItemId = validateGraphId("authoritativeItemId", resolvedItem.id);

  // Read live content for doc_id/created_at recovery. A 404 here is a
  // server-side race (the file vanished between scope resolution and
  // this fetch); surface it as a Graph error so the caller's error
  // formatter does the right thing.
  const liveContent = await getDriveItemContent(client, validatedItemId, signal);

  const now = nowFactory(config);
  const { frontmatter, body, docIdSource } = resolveAuthoritativeFrontmatter({
    agentContent,
    liveContent,
    cachedDocId: metadata.docId,
    projectId: metadata.projectId,
    now,
  });

  // Detect whether the live file's frontmatter was reset (missing /
  // malformed) so the §3.6 audit writer can record one
  // `frontmatter_reset` per write that recovered from the wipe. We
  // only re-read once — `readMarkdownFrontmatter` is pure — to keep
  // the helper's contract intact while still surfacing the reason.
  let frontmatterReset: FrontmatterResetAudit | null = null;
  if (docIdSource === DocIdSource.Cache || docIdSource === DocIdSource.Fresh) {
    const liveRead = readMarkdownFrontmatter(liveContent);
    if (liveRead.kind === "reset") {
      frontmatterReset = {
        reason: liveRead.reason,
        previousRevision: resolvedItem.cTag ?? null,
        recoveredDocId: metadata.docId !== null,
      };
    }
  }

  const yaml = serializeFrontmatter(frontmatter);
  const newContent = joinFrontmatter(yaml, body);
  const updated = await writeAuthoritative(client, validatedItemId, cTag, newContent, signal);
  return { updated, writtenDocId: frontmatter.collab.doc_id, frontmatterReset };
}

/**
 * After a successful authoritative write, refresh the local pin block
 * with the new cTag/revision and (if not already cached) the doc_id.
 * Atomic via {@link saveProjectMetadata}'s temp+rename pattern; a
 * crash here leaves the previous metadata intact so the next session
 * can still resolve the project.
 *
 * `freshDocId` carries the doc_id we just wrote into the file so the
 * cache always matches the live frontmatter — never re-reads from
 * Graph (avoids an extra round-trip and a race with concurrent
 * writers).
 */
export async function persistAuthoritativeMetadata(
  config: ServerConfig,
  metadata: ProjectMetadata,
  updated: DriveItem,
  writtenDocId: string,
  signal: AbortSignal,
): Promise<void> {
  await saveProjectMetadata(
    config.configDir,
    {
      ...metadata,
      docId: writtenDocId,
      lastSeenAuthoritativeCTag: updated.cTag ?? metadata.lastSeenAuthoritativeCTag,
      lastSeenAuthoritativeRevision: updated.version ?? metadata.lastSeenAuthoritativeRevision,
    },
    signal,
  );
}

// ---------------------------------------------------------------------------
// Two-write proposal helper (shared by collab_write conflictMode='proposal'
// and standalone collab_create_proposal)
// ---------------------------------------------------------------------------

/**
 * Execute the §2.3 `collab_create_proposal` two-write flow: PUT a
 * proposal body file under `/proposals/<ulid>.md` (byPath, fresh ULID
 * with a small retry budget for the ProposalIdCollision race), then
 * append a `proposals[]` entry to the live authoritative frontmatter
 * and CAS-write it back with the supplied `authoritativeCTag`.
 *
 * Used by both the standalone `collab_create_proposal` MCP tool and by
 * the `collab_write` `conflictMode: "proposal"` diversion path. The
 * latter case sets `targetSectionSlug` to the synthetic preamble slug
 * because it diverts the agent's full-file write rather than a
 * pre-targeted section.
 *
 * Errors propagate as-is so the caller can map to the standard tool
 * error envelope (CollabCTagMismatchError, MarkdownFileTooLargeError,
 * ProposalIdCollisionError, etc.). Side effects (write counters,
 * audit emission) live in the callers — this helper is the I/O
 * orchestrator only.
 */
export async function runProposalWrite(
  args: {
    client: GraphClient;
    config: ServerConfig;
    metadata: ProjectMetadata;
    session: SessionSnapshot;
    targetSectionSlug: string;
    targetSectionContentHashAtCreate: string;
    proposalBody: string;
    rationale: string;
    source: "chat" | "project" | "external";
    authoritativeCTag: string;
    liveAuthoritativeItem: DriveItem;
    liveAuthoritativeContent: string;
  },
  signal: AbortSignal,
): Promise<{
  proposalId: string;
  proposalItem: DriveItem;
  authoritativeUpdated: DriveItem;
  newDocId: string;
}> {
  // 1. Resolve / lazy-create the proposals/ folder.
  const projectFolderId = validateGraphId("projectFolderId", args.metadata.folderId);
  const proposalsFolderId = await ensureParentFolder(
    args.client,
    projectFolderId,
    [PROPOSALS_FOLDER_NAME],
    signal,
  );

  // 2. Mint a ULID and PUT the proposal body byPath, retrying on the
  //    astronomically-unlikely ProposalIdCollision race. The clock
  //    source is `config.now` so deterministic-time tests are stable.
  const now = nowFactory(args.config)();
  const newUlidWithClock = (): string => newUlid(() => now.getTime());
  let proposalId = "";
  let proposalItem: DriveItem | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < PROPOSAL_ID_RETRY_LIMIT; attempt++) {
    proposalId = newUlidWithClock();
    const fileName = `${proposalId}.md`;
    const target: WriteProjectFileTarget = {
      kind: "create",
      folderId: proposalsFolderId,
      fileName,
      contentType: COLLAB_CONTENT_TYPE_MARKDOWN,
    };
    try {
      proposalItem = await writeProjectFile(args.client, target, args.proposalBody, signal);
      break;
    } catch (err) {
      lastErr = err;
      if (err instanceof ProjectFileAlreadyExistsError) {
        continue;
      }
      throw err;
    }
  }
  if (proposalItem === null) {
    if (lastErr instanceof ProjectFileAlreadyExistsError) {
      throw new ProposalIdCollisionError(projectFolderId, proposalId, PROPOSAL_ID_RETRY_LIMIT);
    }
    if (lastErr instanceof Error) {
      throw lastErr;
    }
    throw new Error("internal: proposal write loop ended without an item");
  }

  // 3. Build the next authoritative frontmatter: parse the live block
  //    (or recover from cache if missing/malformed), append the proposal
  //    entry, leave the body intact. The body comes from the live
  //    content split — we never overwrite the human's prose on a
  //    proposal-create.
  const liveSplit = splitFrontmatter(args.liveAuthoritativeContent);
  const liveBody = liveSplit !== null ? liveSplit.body : args.liveAuthoritativeContent;
  const liveRead = readMarkdownFrontmatter(args.liveAuthoritativeContent);

  let baseFrontmatter: CollabFrontmatter;
  if (liveRead.kind === "parsed") {
    baseFrontmatter = liveRead.frontmatter;
  } else if (args.metadata.docId !== null) {
    baseFrontmatter = {
      collab: {
        version: 1,
        doc_id: args.metadata.docId,
        created_at: now.toISOString(),
        sections: [],
        proposals: [],
        authorship: [],
      },
    };
  } else {
    throw new DocIdRecoveryRequiredError(args.metadata.projectId);
  }

  const proposalEntry: CollabFrontmatter["collab"]["proposals"][number] = {
    id: proposalId,
    target_section_slug: args.targetSectionSlug,
    target_section_content_hash_at_create: args.targetSectionContentHashAtCreate,
    author_agent_id: args.session.agentId,
    author_display_name: args.session.agentId,
    created_at: now.toISOString(),
    status: "open",
    body_path: `${PROPOSALS_FOLDER_NAME}/${proposalId}.md`,
    rationale: args.rationale,
    source: args.source,
  };

  const nextFrontmatter: CollabFrontmatter = {
    collab: {
      ...baseFrontmatter.collab,
      proposals: [...baseFrontmatter.collab.proposals, proposalEntry],
    },
  };

  const yaml = serializeFrontmatter(nextFrontmatter);
  const newContent = joinFrontmatter(yaml, liveBody);

  // 4. CAS-write the authoritative file. A 412 here surfaces as
  //    CollabCTagMismatchError — the agent re-reads and retries.
  const authoritativeItemId = validateGraphId("authoritativeItemId", args.liveAuthoritativeItem.id);
  const authoritativeUpdated = await writeAuthoritative(
    args.client,
    authoritativeItemId,
    args.authoritativeCTag,
    newContent,
    signal,
  );

  return {
    proposalId,
    proposalItem,
    authoritativeUpdated,
    newDocId: nextFrontmatter.collab.doc_id,
  };
}
