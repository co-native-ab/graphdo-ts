// Mail tools - register mail-related MCP tools on a server instance.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getMe, sendMail } from "../graph/mail.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import { formatError } from "./shared.js";
import { GraphScope } from "../scopes.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";

const MAIL_SEND_DEF: ToolDef = {
  name: "mail_send",
  title: "Send Email",
  description:
    "Send an email to yourself via Outlook. The email is sent from and to " +
    "your Microsoft account. Useful for notes, reminders, and forwarding " +
    "information to your inbox.",
  requiredScopes: [GraphScope.MailSend],
};

export const MAIL_TOOL_DEFS: readonly ToolDef[] = [MAIL_SEND_DEF];

/** Register mail-related tools on the given MCP server. */
export function registerMailTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  return [
    defineTool(
      server,
      MAIL_SEND_DEF,
      {
        inputSchema: {
          subject: z.string().describe("Email subject line"),
          body: z.string().describe("Email body content"),
          html: z.boolean().default(false).describe("Whether the body is HTML"),
        },
        annotations: {
          title: MAIL_SEND_DEF.title,
          readOnlyHint: false,
          openWorldHint: true,
        },
      },
      async ({ subject, body, html }, { signal }) => {
        try {
          const client = config.graphClient;
          const user = await getMe(client, signal);
          await sendMail(client, user.mail, subject, body, html, signal);
          logger.info("mail sent", { to: user.mail, subject });
          return {
            content: [{ type: "text", text: `Email sent to ${user.mail}` }],
          };
        } catch (error: unknown) {
          return formatError("mail_send", error);
        }
      },
    ),
  ];
}
