// Best-effort JSONL writer for collab audit envelopes (§3.6). Split out
// from `audit.ts`; re-exported through the barrel.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { logger } from "../logger.js";
import { appendFileOptions, mkdirOptions } from "../fs-options.js";

import { AuditTruncationStage, auditFilePath, type AuditEnvelope } from "./audit-types.js";
import { buildAuditLine } from "./audit-builder.js";

/** Minimum config the writer needs from the host {@link import("../index.js").ServerConfig}. */
export interface AuditWriterConfig {
  configDir: string;
  now?: () => Date;
}

/**
 * Append a single audit envelope to the appropriate JSONL file.
 *
 * **Best-effort.** Failures (disk full, EACCES, parse violations,
 * Bearer rejection, abort) are logged at `warn` and swallowed. Audit
 * is never on the success path of a tool call.
 */
export async function writeAudit(
  config: AuditWriterConfig,
  envelope: AuditEnvelope,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    logger.warn("audit append skipped — signal aborted before write", {
      type: envelope.type,
      projectId: envelope.projectId,
    });
    return;
  }
  const now = config.now?.() ?? new Date();
  let built: ReturnType<typeof buildAuditLine>;
  try {
    built = buildAuditLine(envelope, now);
  } catch (err: unknown) {
    logger.warn("audit envelope rejected before write", {
      type: envelope.type,
      projectId: envelope.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (built.truncated !== AuditTruncationStage.None) {
    logger.warn("audit envelope truncated to fit cap", {
      type: envelope.type,
      projectId: envelope.projectId,
      truncated: built.truncated,
      replaced: built.replaced,
      bytes: built.bytes,
    });
  }

  const filePath = auditFilePath(config.configDir, envelope.projectId);
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, mkdirOptions());
    // O_APPEND is implied by `flag: "a"`. Per POSIX, writes ≤
    // PIPE_BUF are atomic across concurrent appenders.
    // Note: `fs.appendFile` does not accept an AbortSignal in this Node
    // typings version; the caller already aborted-checked above so a
    // late-arriving signal will surface from `mkdir` / `appendFile` as
    // an `AbortError` and be swallowed by the outer catch below.
    await fs.appendFile(filePath, built.line, appendFileOptions());
  } catch (err: unknown) {
    logger.warn("audit append failed", {
      type: envelope.type,
      projectId: envelope.projectId,
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
