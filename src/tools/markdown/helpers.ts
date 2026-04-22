// Internal helpers shared by the markdown tool family:
// schemas, drive-item resolver, formatters, and the best-effort drive
// `webUrl` lookup.

import { z } from "zod";

import type { GraphClient } from "../../graph/client.js";
import { validateGraphId, type ValidatedGraphId } from "../../graph/ids.js";
import {
  findMarkdownFileByName,
  getDriveItem,
  getMyDrive,
  MARKDOWN_FILE_NAME_RULES,
  validateMarkdownFileName,
} from "../../graph/markdown.js";
import type { DriveItem } from "../../graph/types.js";
import type { ServerConfig } from "../../index.js";
import { logger } from "../../logger.js";

/**
 * Boilerplate appended to descriptions and error messages whenever we cite
 * the 4 MiB markdown content cap. Centralised so the wording — including
 * the "tool-side cap" disclaimer — stays consistent across every markdown
 * tool description and error path.
 */
export const MARKDOWN_SIZE_CAP_NOTE = "graphdo-ts tool-side cap, not a Microsoft Graph API limit";

/**
 * Zod schema for strict markdown file names. Applies the full
 * {@link validateMarkdownFileName} check at input-validation time so the MCP
 * SDK rejects bad names before the handler runs.
 */
export const markdownNameSchema = z.string().superRefine((value, ctx) => {
  const result = validateMarkdownFileName(value);
  if (!result.valid) {
    ctx.addIssue({ code: "custom", message: result.reason });
  }
});

// Either an ID or a name must be provided. The input object shape is the
// full union — validation of "exactly one" is done in the handler because MCP
// tool inputs must be plain object schemas without discriminated unions.
//
// The fileName field uses the strict markdown name schema so the MCP SDK
// rejects unsafe or non-portable names (path separators, Windows reserved
// names, etc.) at input-validation time, before any handler code runs. The
// handler still re-validates the resolved item's stored name as defence in
// depth.
export const idOrNameShape = {
  itemId: z
    .string()
    .min(1)
    .optional()
    .describe("Opaque file ID previously returned by markdown_list_files."),
  fileName: markdownNameSchema
    .optional()
    .describe(
      "Markdown file name. Must follow the strict naming rules: " + MARKDOWN_FILE_NAME_RULES,
    ),
} as const;

export async function resolveDriveItem(
  client: ServerConfig["graphClient"],
  folderId: ValidatedGraphId,
  args: { itemId?: string; fileName?: string },
  signal: AbortSignal,
): Promise<DriveItem> {
  if (args.itemId) {
    const itemId = validateGraphId("itemId", args.itemId);
    return getDriveItem(client, itemId, signal);
  }
  if (!args.fileName) {
    throw new Error("Either itemId or fileName must be provided.");
  }
  const validation = validateMarkdownFileName(args.fileName);
  if (!validation.valid) {
    throw new Error(
      `Invalid markdown file name "${args.fileName}": ${validation.reason}. ${MARKDOWN_FILE_NAME_RULES}`,
    );
  }
  const match = await findMarkdownFileByName(client, folderId, args.fileName, signal);
  if (!match) {
    throw new Error(`Markdown file "${args.fileName}" not found in the configured root folder.`);
  }
  // Defensive: the stored name on the remote could still be unsafe even if the
  // caller-supplied name was fine (e.g. a rename happened after creation).
  // Block reads/deletes on such items.
  const storedValidation = validateMarkdownFileName(match.name);
  if (!storedValidation.valid) {
    throw new Error(
      `Matched file "${match.name}" has a name that is not supported by the markdown tools: ` +
        `${storedValidation.reason}. Use markdown_list_files to see entries marked UNSUPPORTED.`,
    );
  }
  return match;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown size";
  return `${String(bytes)} bytes`;
}

/**
 * Format the Revision field for tool output. When the current revision is
 * known (either from the drive item's `version` field or backfilled from
 * `/versions`), report it verbatim. Otherwise direct the agent to
 * `markdown_list_file_versions`, which is the only other path to a usable
 * revision ID.
 */
export function formatRevision(revision: string | undefined): string {
  if (revision !== undefined) return revision;
  return "(unknown - call markdown_list_file_versions to discover)";
}

/** Fallback link used when `GET /me/drive` fails or returns no `webUrl`. */
export const DEFAULT_ONEDRIVE_WEB_URL = "https://onedrive.live.com/";

/**
 * Best-effort fetch of the user's OneDrive `webUrl`. Returns the configured
 * fallback link when the Graph call fails or when the drive has no `webUrl`.
 * We never want the picker to _fail_ just because we couldn't resolve a
 * deep-link — the picker's core function (selecting a folder) does not
 * depend on the create-link being accurate.
 */
export async function tryGetDriveWebUrl(client: GraphClient, signal: AbortSignal): Promise<string> {
  try {
    const drive = await getMyDrive(client, signal);
    const webUrl = drive.webUrl;
    if (typeof webUrl === "string" && webUrl.length > 0) {
      return webUrl;
    }
    logger.warn("/me/drive returned no webUrl; using fallback OneDrive link");
    return DEFAULT_ONEDRIVE_WEB_URL;
  } catch (err: unknown) {
    logger.warn("failed to load /me/drive; using fallback OneDrive link", {
      error: err instanceof Error ? err.message : String(err),
    });
    return DEFAULT_ONEDRIVE_WEB_URL;
  }
}
