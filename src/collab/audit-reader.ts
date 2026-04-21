// Partial-line tolerant JSONL reader for collab audit files (§3.6).
// Split out from `audit.ts`; re-exported through the barrel.

import * as fs from "node:fs/promises";

import { auditFilePath } from "./audit-types.js";

/** Result of {@link parseAuditLines}. */
export interface ParsedAuditLines {
  /** All lines that parsed cleanly as JSON, in file order. */
  entries: Record<string, unknown>[];
  /** Number of lines skipped due to JSON parse failure (e.g. crash mid-write). */
  skipped: number;
}

/**
 * Parse a JSONL file's text into envelopes. Tolerates a partial trailing
 * line (e.g. a process killed mid-write) by silently skipping any line
 * that fails JSON parse. The number of skipped lines is reported so a
 * caller (e.g. an operator) can detect corruption.
 */
export function parseAuditLines(content: string): ParsedAuditLines {
  const entries: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const rawLine of content.split("\n")) {
    if (rawLine.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      skipped += 1;
      continue;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      entries.push(parsed as Record<string, unknown>);
    } else {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/**
 * Read and parse the audit file for `projectId` (or `_unscoped` when
 * `null`). Returns an empty result if the file does not exist.
 */
export async function readAuditFile(
  configDir: string,
  projectId: string | null,
  signal: AbortSignal,
): Promise<ParsedAuditLines> {
  const filePath = auditFilePath(configDir, projectId);
  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: "utf-8", signal });
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "ENOENT"
    ) {
      return { entries: [], skipped: 0 };
    }
    throw err;
  }
  return parseAuditLines(content);
}
