// MCP tool: mail_send — send an email to the signed-in user.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getMe, sendMail } from "../../graph/mail.js";
import type { ServerConfig } from "../../index.js";
import { logger } from "../../logger.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";

const inputSchema = {
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body content"),
  html: z.boolean().default(false).describe("Whether the body is HTML"),
};

const def: ToolDef = {
  name: "mail_send",
  title: "Send Email",
  description:
    "Send an email to yourself via Outlook. The email is sent from and to " +
    "your Microsoft account. Useful for notes, reminders, and forwarding " +
    "information to your inbox.",
  requiredScopes: [GraphScope.MailSend],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async ({ subject, body, html }, { signal }) => {
    try {
      const client = config.graphClient;
      const user = await getMe(client, signal);
      await sendMail(client, user.mail, subject, body, html, signal);
      logger.info("mail sent", { to: user.mail, subject });
      return { content: [{ type: "text", text: `Email sent to ${user.mail}` }] };
    } catch (error: unknown) {
      return formatError("mail_send", error);
    }
  };
}

export const mailSendTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler,
};
