// In-memory session model + per-process registry for collab v1
// (`docs/plans/collab-v1.md` §2.2, §3.7).
//
// A session is bound to the MCP server **OS process**, not to the transport
// connection. Per §2.2 sessions die on:
//
//   - explicit `manual_stop` (not exposed in v1)
//   - TTL expiry (§3.5)
//   - write-budget exhaustion (write tools error; reads still work until TTL)
//   - OS process exit (stdio EOF + signal handler in `main()`)
//
// The destructive counter is mirrored to disk via `session-counts.ts`
// (§3.7) so the file format is stable across process restarts. The
// in-memory state itself does **not** auto-resume on a fresh process —
// `session_open_project` (W4 Day 4) is the supported way to bind to an
// existing project after a restart, and it generates a fresh `sessionId`.
//
// W1 Day 5 lands the registry, the math (TTL, increments), and the
// persistence helper. `session_status` is the first consumer; later
// milestones (session_renew, collab_write, collab_apply_proposal,
// collab_delete_file) all increment counters through this same object.

import {
  DestructiveCountEntrySchema,
  upsertDestructiveCount,
  removeDestructiveCount,
  type DestructiveCountEntry,
} from "./session-counts.js";

// ---------------------------------------------------------------------------
// Defaults from `docs/plans/collab-v1.md` §5.2.1 (init form fields)
// ---------------------------------------------------------------------------

/** Default session TTL: 2h (§5.2.1 init form slider default). */
export const DEFAULT_TTL_SECONDS = 2 * 60 * 60;

/** Hard upper bound on TTL: 8h (§5.2.1 slider max). */
export const MAX_TTL_SECONDS = 8 * 60 * 60;

/** Hard lower bound on TTL: 15 min (§5.2.1 slider min). */
export const MIN_TTL_SECONDS = 15 * 60;

/** Default write budget: 50 (§5.2.1 slider default). */
export const DEFAULT_WRITE_BUDGET = 50;

/** Default destructive budget: 10 (§5.2.1 number default). */
export const DEFAULT_DESTRUCTIVE_BUDGET = 10;

/** Hard cap on destructive budget: 50 (§5.2.1). */
export const MAX_DESTRUCTIVE_BUDGET = 50;

/** Per-session renewal cap (§2.2 `session_renew`). */
export const MAX_RENEWALS_PER_SESSION = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source counter buckets (§2.2 `session_status` "source counters"). */
export interface SourceCounters {
  chat: number;
  project: number;
  external: number;
}

/**
 * Snapshot of a single in-flight session's user-visible state. Returned by
 * {@link SessionRegistry.snapshot} so consumers (e.g. `session_status`) can
 * read state without holding a reference to the mutable internal object.
 */
export interface SessionSnapshot {
  sessionId: string;
  agentId: string;
  userOid: string;
  projectId: string;
  folderPath: string;
  authoritativeFileName: string;
  startedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  writeBudgetTotal: number;
  writesUsed: number;
  destructiveBudgetTotal: number;
  destructiveUsed: number;
  renewalsUsed: number;
  sourceCounters: SourceCounters;
}

/** Inputs to {@link SessionRegistry.start} — captured from the init/open form. */
export interface SessionStartInput {
  projectId: string;
  userOid: string;
  /**
   * Raw `clientInfo.name` reported by the connected MCP client (or `null`
   * when the client sent no `clientInfo` at all). The registry slugifies
   * this internally via {@link slugifyClientName} to derive the middle
   * segment of {@link SessionSnapshot.agentId}; an empty / missing /
   * all-non-slug value falls back to `"unknown"` per §2.2 / §10 question 4
   * and arms the per-session warn-once flag tracked via
   * {@link SessionRegistry.tryMarkAgentNameUnknownEmitted}. Also surfaced
   * verbatim on the `session_start` audit envelope.
   */
  clientName: string | null;
  /** Raw `clientInfo.version` (audit only; not used in `agentId`). */
  clientVersion: string | null;
  folderPath: string;
  authoritativeFileName: string;
  ttlSeconds?: number;
  writeBudget?: number;
  destructiveBudget?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when a session-bound tool runs while no session has been started
 * in this MCP instance. Surfaced by every collab tool; cheap pre-check so
 * the agent knows to call `session_init_project` / `session_open_project`.
 */
export class NoActiveSessionError extends Error {
  constructor() {
    super(
      "No active collab session in this MCP instance. " +
        "Call session_init_project (originator) or session_open_project " +
        "(collaborator) first, then retry the original operation.",
    );
    this.name = "NoActiveSessionError";
  }
}

/**
 * Raised by `session_init_project` and `session_open_project` when an
 * active session already exists in this MCP instance — only one session
 * is supported per process per `docs/plans/collab-v1.md` §2.2.
 */
export class SessionAlreadyActiveError extends Error {
  constructor(public readonly activeProjectId: string) {
    super(
      `An active collab session is already running for projectId ${activeProjectId}. ` +
        "Stop the MCP server (or wait for TTL expiry) before starting a new session.",
    );
    this.name = "SessionAlreadyActiveError";
  }
}

// ---------------------------------------------------------------------------
// Internal mutable session record
// ---------------------------------------------------------------------------

/** Internal mutable session record. Right now identical in shape to
 * {@link SessionSnapshot}; kept distinct so future hidden fields (e.g.
 * a Map of in-flight lease IDs) don't leak through `snapshot()`. */
type InternalSession = SessionSnapshot;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slugify an arbitrary MCP `clientInfo.name` per §2.2 / §10 fallback rules. */
export function slugifyClientName(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return "unknown";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "unknown";
}

/** Compute `agentId = <oidPrefix>-<clientSlug>-<sessionIdPrefix>` (§B6.17). */
export function deriveAgentId(userOid: string, clientSlug: string, sessionId: string): string {
  const oidPrefix = userOid.replace(/-/g, "").slice(0, 8);
  const sessionPrefix = sessionId.slice(0, 8).toLowerCase();
  return `${oidPrefix}-${clientSlug}-${sessionPrefix}`;
}

/** Compute `expiresAt` as an ISO-with-offset string. */
function computeExpiresAt(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

/** Build the on-disk projection of a session for the destructive-counts sidecar. */
function toCountEntry(s: SessionSnapshot): DestructiveCountEntry {
  return DestructiveCountEntrySchema.parse({
    projectId: s.projectId,
    destructiveBudgetTotal: s.destructiveBudgetTotal,
    destructiveUsed: s.destructiveUsed,
    writeBudgetTotal: s.writeBudgetTotal,
    writesUsed: s.writesUsed,
    expiresAt: s.expiresAt,
    renewalsUsed: s.renewalsUsed,
  });
}

/** Generate a session id. Injected so tests can pin the value. */
export type SessionIdFactory = () => string;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Per-process holder for the single active session. Wired into
 * `ServerConfig.sessionRegistry` so every tool reaches the same instance.
 *
 * All counter mutations flush to `<configDir>/sessions/destructive-counts.json`
 * (§3.7) so a future `session_open_project` rebinding by `sessionId` picks
 * up where this process left off rather than resetting the budget.
 */
export class SessionRegistry {
  private active: InternalSession | null = null;
  private agentNameUnknownEmitted = false;

  constructor(
    private readonly configDir: string,
    private readonly newSessionId: SessionIdFactory,
    private readonly now: () => Date,
  ) {}

  /** Returns the snapshot of the active session, or `null` when none exists. */
  snapshot(): SessionSnapshot | null {
    if (this.active === null) return null;
    return cloneSnapshot(this.active);
  }

  /**
   * Try to mark the per-session warn-once `agent_name_unknown` flag.
   *
   * Returns `true` when this is the first call in the current session
   * (caller should emit the audit), or `false` when a previous call has
   * already claimed the slot. No-op (returns `false`) when no session is
   * active. Resets to `false` on every {@link start} / {@link end}.
   */
  tryMarkAgentNameUnknownEmitted(): boolean {
    if (this.active === null) return false;
    if (this.agentNameUnknownEmitted) return false;
    this.agentNameUnknownEmitted = true;
    return true;
  }

  /**
   * `true` when the active session's `expiresAt` is in the past.
   * Returns `false` when no session is active (callers should pre-check
   * with {@link snapshot} when they need to distinguish the two states).
   */
  isExpired(): boolean {
    if (this.active === null) return false;
    return Date.parse(this.active.expiresAt) <= this.now().getTime();
  }

  /** Seconds until `expiresAt`. Returns 0 when expired or no active session. */
  secondsRemaining(): number {
    if (this.active === null) return 0;
    const ms = Date.parse(this.active.expiresAt) - this.now().getTime();
    return ms <= 0 ? 0 : Math.floor(ms / 1000);
  }

  /**
   * Activate a session. Throws {@link SessionAlreadyActiveError} when a
   * session is already running. Persists the destructive-counts sidecar
   * before returning the snapshot so a crash before the next mutation
   * still leaves the row on disk.
   */
  async start(input: SessionStartInput, signal: AbortSignal): Promise<SessionSnapshot> {
    if (this.active !== null) {
      throw new SessionAlreadyActiveError(this.active.projectId);
    }

    const ttlSeconds = clampTtlSeconds(input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    const writeBudget = clampWriteBudget(input.writeBudget ?? DEFAULT_WRITE_BUDGET);
    const destructiveBudget = clampDestructiveBudget(
      input.destructiveBudget ?? DEFAULT_DESTRUCTIVE_BUDGET,
    );

    const sessionId = this.newSessionId();
    const startedAtDate = this.now();
    const startedAt = startedAtDate.toISOString();
    const expiresAt = computeExpiresAt(startedAtDate, ttlSeconds);

    const clientSlug = slugifyClientName(input.clientName);

    const session: InternalSession = {
      sessionId,
      agentId: deriveAgentId(input.userOid, clientSlug, sessionId),
      userOid: input.userOid,
      projectId: input.projectId,
      folderPath: input.folderPath,
      authoritativeFileName: input.authoritativeFileName,
      startedAt,
      expiresAt,
      ttlSeconds,
      writeBudgetTotal: writeBudget,
      writesUsed: 0,
      destructiveBudgetTotal: destructiveBudget,
      destructiveUsed: 0,
      renewalsUsed: 0,
      sourceCounters: { chat: 0, project: 0, external: 0 },
    };

    this.active = session;
    this.agentNameUnknownEmitted = false;
    await this.persist(session, signal);
    return cloneSnapshot(session);
  }

  /**
   * Drop the active session and remove its row from the
   * destructive-counts sidecar (§3.7 "Removed on `session_end`").
   * No-op when no session is active.
   */
  async end(signal: AbortSignal): Promise<void> {
    if (this.active === null) return;
    const sessionId = this.active.sessionId;
    this.active = null;
    this.agentNameUnknownEmitted = false;
    await removeDestructiveCount(this.configDir, sessionId, this.now(), signal);
  }

  /** Increment writes-used. Throws when no session is active. Flushes to disk. */
  async incrementWrites(signal: AbortSignal): Promise<SessionSnapshot> {
    const s = this.requireActive();
    s.writesUsed += 1;
    await this.persist(s, signal);
    return cloneSnapshot(s);
  }

  /** Increment destructive-used. Flushes to disk. */
  async incrementDestructive(signal: AbortSignal): Promise<SessionSnapshot> {
    const s = this.requireActive();
    s.destructiveUsed += 1;
    await this.persist(s, signal);
    return cloneSnapshot(s);
  }

  /** Increment renewals-used. Flushes to disk. */
  async incrementRenewals(signal: AbortSignal): Promise<SessionSnapshot> {
    const s = this.requireActive();
    s.renewalsUsed += 1;
    await this.persist(s, signal);
    return cloneSnapshot(s);
  }

  /** Increment the matching source bucket. Flushes to disk. */
  async incrementSource(
    source: keyof SourceCounters,
    signal: AbortSignal,
  ): Promise<SessionSnapshot> {
    const s = this.requireActive();
    s.sourceCounters[source] += 1;
    await this.persist(s, signal);
    return cloneSnapshot(s);
  }

  /**
   * Reset `expiresAt` to `now + ttlSeconds`. Used by `session_renew`
   * (W4 Day 5). Optionally accepts a fresh TTL; otherwise the existing
   * `ttlSeconds` is reused.
   */
  async renew(ttlSeconds: number | undefined, signal: AbortSignal): Promise<SessionSnapshot> {
    const s = this.requireActive();
    if (ttlSeconds !== undefined) {
      s.ttlSeconds = clampTtlSeconds(ttlSeconds);
    }
    s.expiresAt = computeExpiresAt(this.now(), s.ttlSeconds);
    s.renewalsUsed += 1;
    await this.persist(s, signal);
    return cloneSnapshot(s);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireActive(): InternalSession {
    if (this.active === null) {
      throw new NoActiveSessionError();
    }
    return this.active;
  }

  private async persist(s: InternalSession, signal: AbortSignal): Promise<void> {
    await upsertDestructiveCount(this.configDir, s.sessionId, toCountEntry(s), this.now(), signal);
  }
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

function clampTtlSeconds(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_TTL_SECONDS;
  const truncated = Math.floor(raw);
  if (truncated < MIN_TTL_SECONDS) return MIN_TTL_SECONDS;
  if (truncated > MAX_TTL_SECONDS) return MAX_TTL_SECONDS;
  return truncated;
}

function clampWriteBudget(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_WRITE_BUDGET;
  return Math.floor(raw);
}

function clampDestructiveBudget(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DESTRUCTIVE_BUDGET;
  const truncated = Math.floor(raw);
  if (truncated > MAX_DESTRUCTIVE_BUDGET) return MAX_DESTRUCTIVE_BUDGET;
  return truncated;
}

function cloneSnapshot(s: SessionSnapshot): SessionSnapshot {
  return {
    sessionId: s.sessionId,
    agentId: s.agentId,
    userOid: s.userOid,
    projectId: s.projectId,
    folderPath: s.folderPath,
    authoritativeFileName: s.authoritativeFileName,
    startedAt: s.startedAt,
    expiresAt: s.expiresAt,
    ttlSeconds: s.ttlSeconds,
    writeBudgetTotal: s.writeBudgetTotal,
    writesUsed: s.writesUsed,
    destructiveBudgetTotal: s.destructiveBudgetTotal,
    destructiveUsed: s.destructiveUsed,
    renewalsUsed: s.renewalsUsed,
    sourceCounters: { ...s.sourceCounters },
  };
}
