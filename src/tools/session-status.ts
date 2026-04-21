// `session_status` runner + best-effort leases-cTag lookup.
// Split out from `./session.ts`.

import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import { validateGraphId } from "../graph/ids.js";

import { loadProjectMetadata } from "../collab/projects.js";
import { NoActiveSessionError } from "../collab/session.js";
import { LeasesFileMissingError, readLeases } from "../collab/leases.js";

import { userOidSuffix } from "./session-helpers.js";

export async function runSessionStatus(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<{
  content: { type: "text"; text: string }[];
}> {
  const snap = config.sessionRegistry.snapshot();
  if (snap === null) {
    throw new NoActiveSessionError();
  }
  const expired = config.sessionRegistry.isExpired();
  const secondsRemaining = expired ? 0 : config.sessionRegistry.secondsRemaining();
  const leasesCTag = await readLeasesCTagBestEffort(config, snap.projectId, signal);

  const lines: string[] = [];
  lines.push(`Collab session: ${expired ? "expired" : "active"}`);
  if (config.agentPersona !== undefined) {
    lines.push(
      `  WARN: Test persona active: ${config.agentPersona.id} ` +
        `(GRAPHDO_AGENT_PERSONA override; real user OID unchanged)`,
    );
  }
  lines.push(`  projectId: ${snap.projectId}`);
  lines.push(`  agentId: ${snap.agentId}`);
  lines.push(`  userOid: ...${userOidSuffix(snap.userOid)}`);
  lines.push(`  folderPath: ${snap.folderPath}`);
  lines.push(`  authoritativeFile: ${snap.authoritativeFileName}`);
  lines.push(`  startedAt: ${snap.startedAt}`);
  lines.push(`  expiresAt: ${snap.expiresAt}`);
  lines.push(`  secondsRemaining: ${secondsRemaining}`);
  lines.push(`  expired: ${expired ? "true" : "false"}`);
  lines.push(`  writes: ${snap.writesUsed} / ${snap.writeBudgetTotal}`);
  lines.push(`  destructive approvals: ${snap.destructiveUsed} / ${snap.destructiveBudgetTotal}`);
  lines.push(`  renewals (this session): ${snap.renewalsUsed} / 3`);
  lines.push(
    `  source counters: chat=${snap.sourceCounters.chat} ` +
      `project=${snap.sourceCounters.project} ` +
      `external=${snap.sourceCounters.external}`,
  );
  lines.push(`  leasesCTag: ${leasesCTag}`);
  if (expired) {
    lines.push("");
    lines.push("Session is past its TTL. Use session_renew to reset the clock.");
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

/**
 * Best-effort fetch of the leases-sidecar `cTag` for the active
 * project. Returns one of:
 *
 *   - the live `cTag` when the sidecar exists,
 *   - `"(none)"` when the sidecar has not been lazy-created yet
 *     (`LeasesFileMissingError`),
 *   - `"(unavailable)"` for any other failure (logged at `warn`).
 *
 * The metadata lookup uses the local pin block so we never depend on
 * the sentinel being readable to surface the cTag — a tampered project
 * still gets a useful status line.
 */
async function readLeasesCTagBestEffort(
  config: ServerConfig,
  projectId: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const metadata = await loadProjectMetadata(config.configDir, projectId, signal);
    if (metadata === null) return "(no project metadata)";
    const projectFolderId = validateGraphId("projectFolderId", metadata.folderId);
    const { item } = await readLeases(config.graphClient, projectFolderId, signal);
    return item.cTag ?? "(unknown)";
  } catch (err: unknown) {
    if (err instanceof LeasesFileMissingError) return "(none)";
    logger.warn("session_status: leases cTag lookup failed (best-effort)", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "(unavailable)";
  }
}
