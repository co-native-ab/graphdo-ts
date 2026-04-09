// Mail operations via Microsoft Graph API.

import type { User, SendMailRequest } from "./types.js";
import type { GraphClient } from "./client.js";
import { logger } from "../logger.js";

/** Fetch the authenticated user's profile. */
export async function getMe(client: GraphClient): Promise<User> {
  logger.debug("fetching current user profile");
  const response = await client.request("GET", "/me");
  return (await response.json()) as User;
}

/** Send an email on behalf of the authenticated user. */
export async function sendMail(
  client: GraphClient,
  to: string,
  subject: string,
  body: string,
  html: boolean,
): Promise<void> {
  logger.debug("sending mail", { to, subject });

  const payload: SendMailRequest = {
    message: {
      subject,
      body: {
        contentType: html ? "HTML" : "Text",
        content: body,
      },
      toRecipients: [{ emailAddress: { address: to } }],
    },
  };

  await client.request("POST", "/me/sendMail", payload);
}
