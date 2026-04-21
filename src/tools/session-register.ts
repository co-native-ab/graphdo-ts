// `registerSessionTools` — wires the `session_*` runners into the MCP
// server. Split out from `./session.ts`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  BrowserFormCancelledError,
  DocIdAlreadyKnownError,
  UserCancelledError,
} from "../errors.js";
import type { ServerConfig } from "../index.js";
import type { ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";

import { acquireFormSlot } from "./collab-forms.js";
import { formatError, retryHintForPickerError } from "./shared.js";
import {
  SESSION_INIT_DEF,
  SESSION_OPEN_DEF,
  SESSION_RECOVER_DOC_ID_DEF,
  SESSION_RENEW_DEF,
  SESSION_STATUS_DEF,
} from "./session-defs.js";
import { runInitProject } from "./session-init.js";
import { runOpenProject } from "./session-open.js";
import { runSessionRecoverDocId } from "./session-recover.js";
import { runSessionRenew } from "./session-renew.js";
import { runSessionStatus } from "./session-status.js";

/** Register `session_*` tools on the given MCP server. */
export function registerSessionTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  return [
    defineTool(
      server,
      SESSION_INIT_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_INIT_DEF.title,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (_args, { signal }) => {
        const slot = acquireFormSlot("session_init_project");
        try {
          return await runInitProject(config, slot, signal);
        } catch (err: unknown) {
          if (err instanceof UserCancelledError) {
            return {
              content: [{ type: "text", text: "Project initialisation cancelled." }],
            };
          }
          return formatError("session_init_project", err, {
            suffix: retryHintForPickerError(err),
          });
        } finally {
          slot.release();
        }
      },
    ),
    defineTool(
      server,
      SESSION_STATUS_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_STATUS_DEF.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (_args, { signal }) => {
        try {
          if (signal.aborted) throw signal.reason;
          return await runSessionStatus(config, signal);
        } catch (err: unknown) {
          return formatError("session_status", err);
        }
      },
    ),
    defineTool(
      server,
      SESSION_OPEN_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_OPEN_DEF.title,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (_args, { signal }) => {
        const slot = acquireFormSlot("session_open_project");
        try {
          return await runOpenProject(config, slot, signal);
        } catch (err: unknown) {
          if (err instanceof UserCancelledError) {
            return {
              content: [{ type: "text", text: "Project open cancelled." }],
            };
          }
          return formatError("session_open_project", err, {
            suffix: retryHintForPickerError(err),
          });
        } finally {
          slot.release();
        }
      },
    ),
    defineTool(
      server,
      SESSION_RENEW_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_RENEW_DEF.title,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (_args, { signal }) => {
        try {
          if (signal.aborted) throw signal.reason;
          return await runSessionRenew(config, signal);
        } catch (err: unknown) {
          if (err instanceof UserCancelledError || err instanceof BrowserFormCancelledError) {
            return {
              content: [
                {
                  type: "text",
                  text: "Session renewal cancelled. The TTL clock was not reset.",
                },
              ],
            };
          }
          return formatError("session_renew", err);
        }
      },
    ),
    defineTool(
      server,
      SESSION_RECOVER_DOC_ID_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SESSION_RECOVER_DOC_ID_DEF.title,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (_args, { signal }) => {
        try {
          if (signal.aborted) throw signal.reason;
          return await runSessionRecoverDocId(config, signal);
        } catch (err: unknown) {
          if (err instanceof DocIdAlreadyKnownError) {
            // Informational, not isError per §2.2.
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Nothing to recover.\n  doc_id: ${err.docId}\n` +
                    "Both the live frontmatter and the local project metadata " +
                    "already have a matching doc_id; no version walk was needed.",
                },
              ],
            };
          }
          return formatError("session_recover_doc_id", err);
        }
      },
    ),
  ];
}
