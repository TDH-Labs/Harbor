/**
 * isolation.ts — Capability-based security isolation for agent sessions.
 *
 * Every session runs with a declared identity (room + capabilities). Tools
 * enforce these capabilities at call time; the agent cannot escalate. Model is
 * capability-based (Unix file-descriptors), not role-based.
 *
 * Design principles (ARCHITECTURE.md):
 *   - Deterministic: no ML in the enforcement path. Pure allow/deny.
 *   - Room-gated: skill, MCP, data, and file access.
 *   - Audit-logged: every denial and privileged operation is recorded.
 *
 * De-personalization (BUILD_BRIEF §3) — the prototype hardcoded `ROOM_CAPABILITIES`
 * for a fixed set of machine-specific room names and used a hardcoded privileged
 * room name as a bypass for data/file gating. Both are gone:
 *   - Room capabilities come from config (`config.roomCapabilities(room)`), with
 *     a deny-by-default baseline ({@link DEFAULT_CAPABILITIES}) for unconfigured
 *     rooms. No room name is hardcoded.
 *   - The privilege bypass is the {@link Capability.ADMIN} capability, not a
 *     hardcoded room name.
 *
 * Honest enforcement note (BUILD_BRIEF §6): this is cooperative, tool-level
 * enforcement — not OS-level isolation. An agent with raw filesystem access
 * could bypass it. True unbypassable isolation is a later concern.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { DEFAULT_CAPABILITIES } from "./config.ts";
import { openDb } from "./db.ts";
import type { Environment } from "./env.ts";

// ── Capabilities ─────────────────────────────────────────────────────────────

/** Named capabilities a session can hold (string-valued for stable wire form). */
export enum Capability {
  READ_SKILL = "read_skill",
  LIST_SKILLS = "list_skills",
  READ_SKILL_DIGEST = "read_skill_digest",
  MCP_ACCESS = "mcp_access",
  MCP_MERGE = "mcp_merge",
  DATA_READ = "data_read",
  FILE_READ = "file_read",
  FILE_WRITE = "file_write",
  SCHEDULE = "schedule",
  COMPACT = "compact",
  AUDIT_READ = "audit_read",
  /** Unrestricted privilege (bypasses data/file room-gating). Bootstrap only. */
  ADMIN = "admin",
}

export { DEFAULT_CAPABILITIES };

export type Decision = "allowed" | "denied";

// ── Errors ───────────────────────────────────────────────────────────────────

export class AccessDenied extends Error {
  readonly session: AgentSession | null;
  readonly capability: string;
  readonly resource: string;
  constructor(
    message: string,
    options: { session?: AgentSession | null; capability?: string; resource?: string } = {},
  ) {
    super(message);
    this.name = "AccessDenied";
    this.session = options.session ?? null;
    this.capability = options.capability ?? "";
    this.resource = options.resource ?? "";
  }
}

// ── Agent session ────────────────────────────────────────────────────────────

let sessionCounter = 0;

export interface AgentSessionInit {
  room: string;
  agentId?: string;
  capabilities?: Iterable<string>;
  sessionId?: string;
  createdAt?: number;
}

/** A session with an identity and a fixed capability set. */
export class AgentSession {
  readonly room: string;
  readonly agentId: string;
  readonly capabilities: Set<string>;
  readonly sessionId: string;
  readonly createdAt: number;

  constructor(init: AgentSessionInit) {
    this.room = init.room;
    this.agentId = init.agentId ?? "";
    this.capabilities = new Set(init.capabilities ?? DEFAULT_CAPABILITIES);
    this.createdAt = init.createdAt ?? Date.now() / 1000;
    this.sessionId =
      init.sessionId ??
      createHash("sha256")
        .update(`${this.room}:${this.agentId}:${this.createdAt}:${sessionCounter++}`)
        .digest("hex")
        .slice(0, 16);
  }

  /** Spec compatibility alias for `sessionId`. */
  get id(): string {
    return this.sessionId;
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability);
  }

  /** Throw {@link AccessDenied} if the capability is not held; audit on denial. */
  check(capability: string, resource = "", env?: Environment): void {
    if (!this.has(capability)) {
      if (env) {
        auditLog(env, this, {
          event: "capability_denied",
          capability,
          resource,
          decision: "denied",
          reason: `room '${this.room}' lacks '${capability}'`,
        });
      }
      throw new AccessDenied(
        `Agent in room '${this.room}' lacks capability '${capability}'` +
          (resource ? ` for '${resource}'` : ""),
        { session: this, capability, resource },
      );
    }
  }

  /** Skills allowed for this room (empty ⇒ no room-skill restriction). */
  roomSkills(env: Environment): Set<string> {
    return env.config.roomSkillSet(this.room);
  }

  roomSkillAllowed(env: Environment, skillName: string): boolean {
    const allowed = this.roomSkills(env);
    if (allowed.size === 0) return true; // no restriction configured
    return allowed.has(skillName);
  }

  roomMcpAllowed(env: Environment, mcpServer: string): boolean {
    const servers = env.config.roomMcpServers(this.room);
    if (servers.length === 0) return false;
    return servers.includes(mcpServer);
  }
}

// ── Capability decorator / wrapper ───────────────────────────────────────────

/**
 * Wrap a tool function so its capability is enforced before it runs. The wrapped
 * function takes the {@link AgentSession} as its first argument (matches the
 * prototype's `require_capability` decorator; this is the building block Phase 3
 * `gate.ts` composes on).
 */
export function requireCapability<A extends unknown[], R>(
  capability: Capability | string,
  fn: (session: AgentSession, ...args: A) => R,
): (session: AgentSession, ...args: A) => R {
  return (session: AgentSession, ...args: A): R => {
    session.check(capability);
    return fn(session, ...args);
  };
}

// ── Per-resource enforcement ─────────────────────────────────────────────────

/** Full skill access check: capability + room membership. */
export function checkSkillAccess(
  session: AgentSession,
  env: Environment,
  skillName: string,
): boolean {
  if (!session.has(Capability.READ_SKILL)) return false;
  return session.roomSkillAllowed(env, skillName);
}

/** Full MCP access check: capability + room ownership of the server. */
export function checkMcpAccess(
  session: AgentSession,
  env: Environment,
  mcpServer: string,
): boolean {
  if (!session.has(Capability.MCP_ACCESS)) return false;
  return session.roomMcpAllowed(env, mcpServer);
}

/** Data access: capability + the DB must live under `data/<room>/` (or ADMIN). */
export function checkDataAccess(
  session: AgentSession,
  dbPath: string,
  env?: Environment,
): boolean {
  if (!session.has(Capability.DATA_READ)) return false;
  if (session.has(Capability.ADMIN)) return true;
  const normalized = stripBase(dbPath, env);
  return normalized.startsWith(`data/${session.room}/`);
}

/** File access: capability + the path must live under `workspace/<room>/` (or ADMIN). */
export function checkFileAccess(
  session: AgentSession,
  filePath: string,
  mode: "read" | "write" = "read",
  env?: Environment,
): boolean {
  const cap = mode === "write" ? Capability.FILE_WRITE : Capability.FILE_READ;
  if (!session.has(cap)) return false;
  if (session.has(Capability.ADMIN)) return true;
  const normalized = stripBase(filePath, env);
  return normalized.startsWith(`workspace/${session.room}/`);
}

function stripBase(p: string, env?: Environment): string {
  const base = env ? env.root : homedir();
  const stripped = p.startsWith(base) ? p.slice(base.length) : p;
  return stripped.replace(/^\/+/, "");
}

// ── Audit logging ────────────────────────────────────────────────────────────
// Schema satisfies the contract columns (decision, reason) and keeps the
// prototype's agent_id / event for fidelity.

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp REAL NOT NULL,
    session_id TEXT NOT NULL,
    room TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL DEFAULT '',
    capability TEXT NOT NULL DEFAULT '',
    resource TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL DEFAULT 'denied',
    reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_room ON audit_log(room);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
`;

export interface AuditEntry {
  id: number;
  timestamp: number;
  sessionId: string;
  room: string;
  agentId: string;
  event: string;
  capability: string;
  resource: string;
  decision: Decision;
  reason: string;
}

export interface AuditLogInput {
  event: string;
  capability?: string;
  resource?: string;
  decision?: Decision;
  reason?: string;
}

/**
 * The audit log's long-lived, cached connection (one per `isolation.db` path).
 * Audit writes are append-only inserts; sharing a single connection means an
 * in-process denial is serialized and immediately visible to the next
 * `auditRead`/`denialsToday`, and (with `busy_timeout`) concurrent writers from
 * other connections wait rather than dropping the row — denials always land.
 */
function auditDb(env: Environment): Database {
  const path = env.isolationDb;
  mkdirSync(dirname(path), { recursive: true });
  return openDb(path, (db) => {
    // busy_timeout before journal_mode — see compaction.ts: the WAL switch can
    // need recovery, and a concurrent first-open without the timeout set fails
    // immediately with SQLITE_BUSY_RECOVERY instead of waiting for the lock.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(AUDIT_SCHEMA);
  }).db;
}

/** Record an audit event. Defaults to a "denied" decision (deny-by-default). */
export function auditLog(env: Environment, session: AgentSession, input: AuditLogInput): void {
  auditDb(env)
    .query(
      `INSERT INTO audit_log
         (timestamp, session_id, room, agent_id, event, capability, resource, decision, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now() / 1000,
      session.sessionId,
      session.room,
      session.agentId,
      input.event,
      input.capability ?? "",
      input.resource ?? "",
      input.decision ?? "denied",
      input.reason ?? "",
    );
}

/** Read recent audit entries, optionally filtered by room. */
export function auditRead(
  env: Environment,
  options: { room?: string; limit?: number } = {},
): AuditEntry[] {
  const limit = options.limit ?? 50;
  const db = auditDb(env);
  const rows = options.room
    ? (db
        .query("SELECT * FROM audit_log WHERE room = ? ORDER BY timestamp DESC LIMIT ?")
        .all(options.room, limit) as AuditRow[])
    : (db.query("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?").all(limit) as AuditRow[]);
  return rows.map(rowToAudit);
}

/** Count denied access attempts today (since UTC midnight). */
export function auditDenialsToday(env: Environment, room?: string): number {
  const nowSec = Date.now() / 1000;
  const todayStart = nowSec - (nowSec % 86400);
  const db = auditDb(env);
  const row = room
    ? (db
        .query(
          "SELECT COUNT(*) AS n FROM audit_log WHERE timestamp >= ? AND room = ? AND decision = 'denied'",
        )
        .get(todayStart, room) as { n: number })
    : (db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE timestamp >= ? AND decision = 'denied'")
        .get(todayStart) as { n: number });
  return row.n;
}

interface AuditRow {
  id: number;
  timestamp: number;
  session_id: string;
  room: string;
  agent_id: string;
  event: string;
  capability: string;
  resource: string;
  decision: string;
  reason: string;
}

function rowToAudit(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    timestamp: r.timestamp,
    sessionId: r.session_id,
    room: r.room,
    agentId: r.agent_id,
    event: r.event,
    capability: r.capability,
    resource: r.resource,
    decision: r.decision as Decision,
    reason: r.reason,
  };
}

// ── Session factory ──────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  room: string;
  agentId?: string;
  /** Explicit capabilities; otherwise resolved from config, then the baseline. */
  capabilities?: Iterable<string>;
  /** Resolves room capabilities from config and enables audit logging. */
  env?: Environment;
  sessionId?: string;
  createdAt?: number;
}

/**
 * Create an agent session with room-resolved capabilities. Logs creation to the
 * audit trail when `env` is provided.
 */
export function createSession(options: CreateSessionOptions): AgentSession {
  const capabilities =
    options.capabilities ??
    (options.env ? options.env.config.roomCapabilities(options.room) : DEFAULT_CAPABILITIES);

  const session = new AgentSession({
    room: options.room,
    agentId: options.agentId,
    capabilities,
    sessionId: options.sessionId,
    createdAt: options.createdAt,
  });

  if (options.env) {
    auditLog(options.env, session, {
      event: "session_created",
      decision: "allowed",
      reason: `room=${options.room} caps=${[...session.capabilities].sort().join(",")}`,
    });
  }
  return session;
}
