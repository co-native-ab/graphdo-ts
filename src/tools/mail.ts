// Mail tools — register mail-related MCP tools on a server instance.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphClient, GraphRequestError } from "../graph/client.js";
import { getMe, sendMail } from "../graph/mail.js";
import { GRAPH_BASE_URL } from "../index.js";
import { logger } from "../logger.js";

/** Register mail-related tools on the given MCP server. */
export function registerMailTools(server: McpServer): void {
  server.registerTool(
    "mail_send",
    {
      description:
        "Send an email to yourself. The email will be sent from and to your Microsoft account.",
      inputSchema: {
        subject: z.string().describe("Email subject line"),
        body: z.string().describe("Email body content"),
        html: z
          .boolean()
          .default(false)
          .describe("Whether the body is HTML"),
      },
      annotations: {
        title: "Send Email",
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ subject, body, html }, extra) => {
      const token = extra.authInfo?.token;
      if (!token) {
        return {
          content: [{ type: "text" as const, text: "Unauthorized: no Bearer token provided" }],
          isError: true,
        };
      }

      try {
        const client = new GraphClient(GRAPH_BASE_URL, token);
        const user = await getMe(client);
        await sendMail(client, user.mail, subject, body, html);
        logger.info("mail sent", { to: user.mail, subject });
        return {
          content: [{ type: "text" as const, text: `Email sent to ${user.mail}` }],
        };
      } catch (error: unknown) {
        const message =
          error instanceof GraphRequestError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        logger.error("mail_send failed", { error: message });
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );
}
