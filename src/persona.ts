// Test-persona override for collab v1 (`docs/plans/two-instance-e2e.md`,
// ADR-0009). Lets two MCP server processes on the same machine — both
// authenticated as the same Microsoft user — be treated as **two
// distinct collaborators** by collab's destructive classifier,
// authorship trail, lease ownership, and audit envelopes.
//
// **The override changes labels, not authority.** Graph requests still
// use the same MSAL token from the same MSAL cache; Microsoft attributes
// every write to the one real user. The persona id never reaches
// Graph — it is a collab-layer label only.
//
// The env var is read **once** in `main()` and threaded through
// `ServerConfig.agentPersona`. There is no runtime mutation point and
// no on-disk persistence — the override naturally dies with the
// process. See ADR-0009 for the full threat model.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Strict shape for any persona id the server accepts.
 *
 * Format: `^persona:[a-z0-9-]{1,32}$` — prefixed with the literal
 * `persona:` so a synthetic id is unambiguously distinguishable from
 * an Entra `oid` UUID. Lower-case + digits + hyphens, 1–32 chars
 * after the prefix; total length ≤ 40.
 *
 * The prefix is a **defence-in-depth** measure against confusion with
 * a real `oid`: GUIDs contain hyphens but never the literal substring
 * `persona:`, and the regex below also rejects the GUID character set
 * (uppercase hex / no `persona:` prefix), so audit consumers can tell
 * synthetic personas from real users at a glance.
 */
export const AgentPersonaIdSchema = z
  .string()
  .regex(
    /^persona:[a-z0-9-]{1,32}$/,
    "agent persona id must match /^persona:[a-z0-9-]{1,32}$/ (lower-case alphanumerics + hyphens)",
  );

/** TypeScript view of {@link AgentPersonaIdSchema}. */
export type AgentPersonaId = z.infer<typeof AgentPersonaIdSchema>;

/**
 * Resolved persona override. Threaded through `ServerConfig.agentPersona`
 * and consumed by the session registry, audit writer, and status tools.
 *
 * `rawEnvValue` is captured verbatim (before validation) so the warn-once
 * startup log can surface what the operator actually typed when the
 * value parses cleanly. For invalid values the parser throws before
 * this struct is built.
 */
export interface AgentPersona {
  /** Validated id, e.g. `"persona:alice"`. */
  id: AgentPersonaId;
  /** Verbatim env-var contents (already known to equal `id` after parse). */
  rawEnvValue: string;
  /** Always `"env"` today; reserved for future config-file sources. */
  source: "env";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when `GRAPHDO_AGENT_PERSONA` is set to a value that fails {@link AgentPersonaIdSchema}. */
export class InvalidAgentPersonaError extends Error {
  constructor(
    public readonly rawValue: string,
    public readonly reason: string,
  ) {
    super(
      `GRAPHDO_AGENT_PERSONA value is invalid: ${reason}. ` +
        `Got: ${JSON.stringify(rawValue)}. ` +
        "Use a value matching ^persona:[a-z0-9-]{1,32}$ (e.g. 'persona:alice').",
    );
    this.name = "InvalidAgentPersonaError";
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Env var name read by {@link parseAgentPersonaFromEnv}. */
export const AGENT_PERSONA_ENV_VAR = "GRAPHDO_AGENT_PERSONA" as const;

/**
 * Resolve the persona override from a (typically `process.env`-shaped)
 * environment record. Returns `undefined` when the env var is absent
 * or empty (treated as "not set"); throws {@link InvalidAgentPersonaError}
 * when the value is present but fails validation. **Never** silently
 * falls back — a typo must surface as a startup failure rather than
 * letting collab quietly run with the default `agentId`.
 *
 * Whitespace-only and pure-empty values are treated as "not set" (the
 * convenience case where a CI runner sets the var to an empty string).
 */
export function parseAgentPersonaFromEnv(env: NodeJS.ProcessEnv): AgentPersona | undefined {
  const raw = env[AGENT_PERSONA_ENV_VAR];
  if (raw === undefined) return undefined;
  if (raw.trim().length === 0) return undefined;
  const result = AgentPersonaIdSchema.safeParse(raw);
  if (!result.success) {
    const reason = result.error.issues[0]?.message ?? "schema validation failed";
    throw new InvalidAgentPersonaError(raw, reason);
  }
  return {
    id: result.data,
    rawEnvValue: raw,
    source: "env",
  };
}

// ---------------------------------------------------------------------------
// Helpers used elsewhere in the codebase
// ---------------------------------------------------------------------------

/**
 * Resolve the **effective** collab `agentId` for a session.
 *
 * - When a persona override is active, the persona id (e.g.
 *   `"persona:alice"`) wholly replaces the derived
 *   `<oidPrefix>-<clientSlug>-<sessionPrefix>` shape so collab's
 *   destructive classifier, authorship-trail comparator, lease
 *   ownership checks, and audit envelopes all key off the **stable**
 *   per-process label rather than an ephemeral session prefix. This
 *   is what lets two MCP processes (Alice + Bob) on the same
 *   Microsoft account behave as two distinct collaborators.
 * - When no persona is set, the caller's existing `derivedAgentId`
 *   is returned unchanged (back-compat: byte-identical audit shape).
 */
export function effectiveAgentId(
  persona: AgentPersona | undefined,
  derivedAgentId: string,
): string {
  return persona?.id ?? derivedAgentId;
}
