// Cross-platform filesystem option helpers.
//
// Several modules (`src/config.ts`, `src/collab/projects.ts`,
// `src/collab/session-counts.ts`, `src/collab/audit.ts`) need the same
// platform-conditional `mode` handling on `fs.mkdir` / `fs.writeFile` /
// `fs.appendFile`: POSIX gets restrictive permissions (`0o700` on
// directories, `0o600` on files), Windows omits the `mode` field
// because NTFS ignores it and the typings warn. Centralising the
// branch in one place keeps the policy uniform and removes the
// "remember to set 0o600" footgun from every caller.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** Restrictive directory permission on POSIX (owner rwx). */
export const POSIX_DIR_MODE = 0o700;

/** Restrictive file permission on POSIX (owner rw). */
export const POSIX_FILE_MODE = 0o600;

function isWindows(): boolean {
  return os.platform() === "win32";
}

/**
 * Returns `fs.mkdir` options with `recursive: true` plus the restrictive
 * POSIX directory mode (omitted on Windows where it is not honoured).
 */
export function mkdirOptions(): Parameters<typeof fs.mkdir>[1] {
  return isWindows() ? { recursive: true } : { recursive: true, mode: POSIX_DIR_MODE };
}

/**
 * Returns `fs.writeFile` options with the restrictive POSIX file mode
 * (omitted on Windows). The `signal` is forwarded so callers can wire
 * cancellation through to the underlying write.
 */
export function writeFileOptions(signal?: AbortSignal): Parameters<typeof fs.writeFile>[2] {
  return isWindows()
    ? { encoding: "utf-8" as const, signal }
    : { encoding: "utf-8" as const, mode: POSIX_FILE_MODE, signal };
}

/**
 * Returns `fs.appendFile` options with `flag: "a"` (so `O_APPEND` is
 * implied on POSIX) plus the restrictive POSIX file mode (omitted on
 * Windows). `fs.appendFile` does not accept `AbortSignal` in current
 * Node typings — callers should `signal.aborted`-check before calling.
 */
export function appendFileOptions(): Parameters<typeof fs.appendFile>[2] {
  return isWindows()
    ? { encoding: "utf-8" as const, flag: "a" }
    : { encoding: "utf-8" as const, flag: "a", mode: POSIX_FILE_MODE };
}

/**
 * Atomically write `data` as JSON to `filePath`: ensure the parent
 * directory exists, write to a unique temp file in the same directory,
 * then `rename` it into place (POSIX atomic on the same volume). On
 * any error the temp file is best-effort removed and the original error
 * is re-thrown.
 *
 * Used by every collab on-disk codec (project metadata, recents,
 * renewal counts, session counts) — duplicated three ways in earlier
 * milestone code; consolidated here so file-mode policy and crash
 * semantics never drift between callers.
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, mkdirOptions());

  const body = JSON.stringify(data, null, 2) + "\n";
  const tmpFile = path.join(dir, `.${path.basename(filePath)}-${crypto.randomUUID()}.tmp`);

  try {
    await fs.writeFile(tmpFile, body, writeFileOptions(signal));
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
