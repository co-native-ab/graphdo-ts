// Mail tools - register mail-related MCP tools on a server instance.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AuthenticationRequiredError } from "../errors.js";
import { GraphClient } from "../graph/client.js";
import { getMe, sendMail } from "../graph/mail.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";

/** Register mail-related tools on the given MCP server. */
export function registerMailTools(
  server: McpServer,
  config: ServerConfig,
): void {
  server.registerTool(
    "mail_send",
    {
      description:
        "Send an email to yourself via Outlook. The email is sent from and to " +
        "your Microsoft account. Useful for notes, reminders, and forwarding " +
        "information to your inbox.",
      inputSchema: {
        subject: z.string().describe("Email subject line"),
        body: z.string().describe("Email body content"),
        html: z.boolean().default(false).describe("Whether the body is HTML"),
      },
      annotations: {
        title: "Send Email",
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ subject, body, html }) => {
      try {
        const token = await config.authenticator.token();
        const client = new GraphClient(config.graphBaseUrl, token);
        const user = await getMe(client);
        await sendMail(client, user.mail, subject, body, html);
        logger.info("mail sent", { to: user.mail, subject });
        return {
          content: [
            { type: "text", text: `Email sent to ${user.mail}` },
          ],
        };
      } catch (error: unknown) {
        if (error instanceof AuthenticationRequiredError) {
          return {
            content: [{ type: "text", text: error.message }],
            isError: true,
          };
        }
        const message =
          error instanceof Error
            ? error.message
            : String(error);
        logger.error("mail_send failed", { error: message });
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    },
  );
}
