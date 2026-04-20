import { describe, expect, it } from "vitest";

import {
  AGENT_PERSONA_ENV_VAR,
  AgentPersonaIdSchema,
  InvalidAgentPersonaError,
  effectiveAgentId,
  parseAgentPersonaFromEnv,
} from "../src/persona.js";

describe("AgentPersonaIdSchema", () => {
  it.each([
    "persona:alice",
    "persona:bob",
    "persona:a",
    "persona:agent-1",
    "persona:" + "a".repeat(32),
    "persona:01234567890123456789012345678901",
    "persona:test-1-2-3",
  ])("accepts %s", (value) => {
    expect(AgentPersonaIdSchema.parse(value)).toBe(value);
  });

  it.each([
    ["empty string", ""],
    ["missing prefix", "alice"],
    ["wrong prefix", "user:alice"],
    ["uppercase", "persona:Alice"],
    ["whitespace inside", "persona:al ice"],
    ["GUID-shaped", "persona:550e8400-e29b-41d4-a716-446655440000".toUpperCase()],
    ["too long", "persona:" + "a".repeat(33)],
    ["just prefix", "persona:"],
    ["control chars", "persona:al\x00ice"],
    ["leading colon", ":persona:alice"],
    ["trailing whitespace", "persona:alice "],
    ["leading whitespace", " persona:alice"],
    ["non-ascii", "persona:ålice"],
    ["underscore", "persona:al_ice"],
    ["dot", "persona:al.ice"],
    ["plus", "persona:al+ice"],
    ["slash", "persona:al/ice"],
  ])("rejects %s", (_label, value) => {
    expect(AgentPersonaIdSchema.safeParse(value).success).toBe(false);
  });
});

describe("parseAgentPersonaFromEnv", () => {
  it("returns undefined when env var is absent", () => {
    expect(parseAgentPersonaFromEnv({})).toBeUndefined();
  });

  it("returns undefined when env var is empty", () => {
    expect(parseAgentPersonaFromEnv({ [AGENT_PERSONA_ENV_VAR]: "" })).toBeUndefined();
  });

  it("returns undefined when env var is whitespace only", () => {
    expect(parseAgentPersonaFromEnv({ [AGENT_PERSONA_ENV_VAR]: "   " })).toBeUndefined();
  });

  it("returns the parsed persona for a valid value", () => {
    const persona = parseAgentPersonaFromEnv({ [AGENT_PERSONA_ENV_VAR]: "persona:alice" });
    expect(persona).toEqual({
      id: "persona:alice",
      rawEnvValue: "persona:alice",
      source: "env",
    });
  });

  it("throws InvalidAgentPersonaError for an invalid value", () => {
    expect(() => parseAgentPersonaFromEnv({ [AGENT_PERSONA_ENV_VAR]: "Alice" })).toThrow(
      InvalidAgentPersonaError,
    );
  });

  it("error message includes the offending value and a hint", () => {
    try {
      parseAgentPersonaFromEnv({ [AGENT_PERSONA_ENV_VAR]: "bob" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAgentPersonaError);
      const message = (err as Error).message;
      expect(message).toContain('"bob"');
      expect(message).toContain("persona:");
    }
  });
});

describe("effectiveAgentId", () => {
  it("returns persona id when persona is set", () => {
    expect(
      effectiveAgentId(
        { id: "persona:alice", rawEnvValue: "persona:alice", source: "env" },
        "abc12345-vscode-def67890",
      ),
    ).toBe("persona:alice");
  });

  it("returns derived id when persona is undefined", () => {
    expect(effectiveAgentId(undefined, "abc12345-vscode-def67890")).toBe(
      "abc12345-vscode-def67890",
    );
  });
});
