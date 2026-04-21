// `session_renew` runner. Split out from `./session.ts`.

import {
  BrowserFormCancelledError,
  RenewalCapPerSessionError,
  RenewalCapPerWindowError,
  UserCancelledError,
} from "../errors.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import { startBrowserPicker } from "../picker.js";

import { writeAudit, AuditResult } from "../collab/audit.js";
import { MAX_RENEWALS_PER_SESSION, NoActiveSessionError } from "../collab/session.js";
import {
  recordRenewal,
  renewalKey,
  windowCount,
  MAX_RENEWALS_PER_WINDOW,
  RENEWAL_WINDOW_MS,
} from "../collab/renewal-counts.js";

import { acquireFormSlot } from "./collab-forms.js";
import { nowFactory } from "./shared.js";

export async function runSessionRenew(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const now = nowFactory(config);

  const snap = config.sessionRegistry.snapshot();
  if (snap === null) {
    throw new NoActiveSessionError();
  }

  // Pre-check the per-session cap. The registry's `renew()` itself does
  // not enforce this — keeping the policy in the tool layer keeps
  // counters and forms aligned (we never open a form we are about to
  // refuse anyway).
  if (snap.renewalsUsed >= MAX_RENEWALS_PER_SESSION) {
    throw new RenewalCapPerSessionError(snap.renewalsUsed, MAX_RENEWALS_PER_SESSION);
  }

  // Pre-check the per-window cap. The sliding window is keyed by
  // `(userOid, projectId)` per §3.5 — `loadRenewalCounts` prunes entries
  // older than 24h on read so a stale row never blocks a fresh renewal.
  const key = renewalKey(snap.userOid, snap.projectId);
  const beforeCount = await windowCount(config.configDir, key, now(), signal);
  if (beforeCount >= MAX_RENEWALS_PER_WINDOW) {
    throw new RenewalCapPerWindowError(
      beforeCount,
      MAX_RENEWALS_PER_WINDOW,
      RENEWAL_WINDOW_MS / (60 * 60 * 1000),
    );
  }

  // Open the §5.2 re-approval form via the W0 form-factory slot.
  const slot = acquireFormSlot("session_renew");
  try {
    const summaryLines = [
      `projectId: ${snap.projectId}`,
      `folderPath: ${snap.folderPath}`,
      `currentExpiresAt: ${snap.expiresAt}`,
      `ttlSeconds (will be re-applied on approve): ${snap.ttlSeconds}`,
      `renewals (this session): ${snap.renewalsUsed} / ${MAX_RENEWALS_PER_SESSION}`,
      `renewals (rolling 24h): ${beforeCount} / ${MAX_RENEWALS_PER_WINDOW}`,
      `writes used: ${snap.writesUsed} / ${snap.writeBudgetTotal}`,
      `destructive used: ${snap.destructiveUsed} / ${snap.destructiveBudgetTotal}`,
    ];
    const handle = await startBrowserPicker(
      {
        title: "Approve Session Renewal",
        subtitle:
          "An MCP tool is asking to reset the session TTL clock. Counters " +
          "(writes / destructive / sources) are preserved across the renewal. " +
          "Click Approve to renew, or Cancel to refuse.\n\n" +
          summaryLines.join("\n"),
        options: [{ id: "approve", label: "Approve session renewal" }],
        onSelect: async () => {
          // Counter mutations happen after the picker resolves so the
          // slot URL stays useful in FormBusyError messages until the
          // sidecar write + registry update complete.
        },
      },
      signal,
    );
    slot.setUrl(handle.url);

    let browserOpened = false;
    try {
      await config.openBrowser(handle.url);
      browserOpened = true;
      logger.info("session_renew picker opened", { url: handle.url });
    } catch (err: unknown) {
      logger.warn("could not open browser for session_renew", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!browserOpened) {
      logger.info("session_renew awaiting manual visit", { url: handle.url });
    }

    try {
      await handle.waitForSelection;
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) {
        throw new BrowserFormCancelledError("session_renew");
      }
      throw err;
    }

    // Approved — append to the sliding window, then reset the TTL
    // clock. Order matters: the persisted window entry is the source of
    // truth for the per-user/per-project cap, so writing it first means
    // a crash between the two operations still records the cap usage
    // (rather than letting the agent retry forever for free).
    const recorded = await recordRenewal(config.configDir, key, now(), signal);
    const renewedSnap = await config.sessionRegistry.renew(undefined, signal);

    // §3.6 audit envelope. Best-effort — the writer swallows failures
    // and never fails the tool call.
    await writeAudit(
      config,
      {
        sessionId: renewedSnap.sessionId,
        agentId: renewedSnap.agentId,
        userOid: renewedSnap.userOid,
        projectId: renewedSnap.projectId,
        tool: "session_renew",
        result: AuditResult.Success,
        type: "renewal",
        details: {
          windowCountBefore: recorded.windowCountBefore,
          windowCountAfter: recorded.windowCountAfter,
          sessionRenewalsBefore: snap.renewalsUsed,
          sessionRenewalsAfter: renewedSnap.renewalsUsed,
        },
      },
      signal,
    );

    const lines = [
      "Session renewed.",
      `  sessionId: ${renewedSnap.sessionId}`,
      `  expiresAt: ${renewedSnap.expiresAt}`,
      `  ttlSeconds: ${renewedSnap.ttlSeconds}`,
      `  renewals (this session): ${renewedSnap.renewalsUsed} / ${MAX_RENEWALS_PER_SESSION}`,
      `  renewals (rolling 24h): ${recorded.windowCountAfter} / ${MAX_RENEWALS_PER_WINDOW}`,
      `  writes: ${renewedSnap.writesUsed} / ${renewedSnap.writeBudgetTotal}`,
      `  destructive: ${renewedSnap.destructiveUsed} / ${renewedSnap.destructiveBudgetTotal}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } finally {
    slot.release();
  }
}
