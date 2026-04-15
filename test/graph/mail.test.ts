import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, testSignal, type TestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import { getMe, sendMail } from "../../src/graph/mail.js";

describe("mail operations", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("getMe() returns user profile with correct fields", async () => {
    const user = await getMe(client, testSignal());
    expect(user.id).toBe("user-1");
    expect(user.displayName).toBe("Test User");
    expect(user.mail).toBe("test@example.com");
    expect(user.userPrincipalName).toBe("test@example.com");
  });

  it("sendMail() records mail in mock state", async () => {
    await sendMail(client, "bob@example.com", "Hello", "Hi Bob", false, testSignal());
    const mails = env.state.getSentMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("bob@example.com");
    expect(mails[0]!.subject).toBe("Hello");
    expect(mails[0]!.body).toBe("Hi Bob");
  });

  it("sendMail() with html=true sets contentType to HTML", async () => {
    await sendMail(client, "a@b.com", "subj", "<b>hi</b>", true, testSignal());
    const mails = env.state.getSentMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.contentType).toBe("HTML");
  });

  it("sendMail() with html=false sets contentType to Text", async () => {
    await sendMail(client, "a@b.com", "subj", "plain text", false, testSignal());
    const mails = env.state.getSentMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.contentType).toBe("Text");
  });

  it("sent mail has correct to, subject, body", async () => {
    await sendMail(client, "recipient@test.com", "Important", "Body content", false, testSignal());
    const mails = env.state.getSentMails();
    expect(mails).toHaveLength(1);
    const mail = mails[0]!;
    expect(mail).toEqual({
      to: "recipient@test.com",
      subject: "Important",
      body: "Body content",
      contentType: "Text",
    });
  });
});
