/**
 * session.ts — Track agent sessions with file-based state + SQLite rollup.
 *
 * Each session writes its live state to `sessions/<id>/state.json` (a low-latency
 * read for agent extensions, language-agnostic) and an append-only
 * `events.jsonl`. On end, the session rolls up into `sessions.db` for the
 * dashboard and historical reporting.
 *
 * Design (ARCHITECTURE.md): file-based for low-latency reads, SQLite for query,
 * deterministic (no LLM, no network).
 *
 * De-personalization (BUILD_BRIEF §3): the prototype chose per-room default
 * budgets from a hardcoded map keyed by this machine's room names. v1 resolves
 * the budget from config (`config.roomBudget(room)`), and capabilities /
 * allowed skills / MCP servers from config — nothing room-specific is hardcoded.
 *
 * The persisted state.json uses the camelCase {@link SessionState} shape (this
 * is a clean v1 format, not a port of the prototype's snake_case file).
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Environment } from "./env.ts";
import { AgentSession, auditLog } from "./isolation.ts";

// ── Types ──────────────────────────────────────────────────────────────────--

export interface SessionState {
  sessionId: string;
  room: string;
  agentId: string;
  startedAt: number;
  startedIso: string;
  tokenLimit: number;
  tokensUsed: number;
  tokensRemaining: number;
  capabilities: string[];
  allowedSkills: string[];
  allowedSkillsCount: number;
  allowedMcpServers: string[];
  status: string;
  events: number;
  endedAt?: number;
  endedIso?: string;
  summary?: string;
}

export interface StartOptions {
  agentId?: string;
  /** Explicit token budget; otherwise resolved from `config.roomBudget(room)`. */
  budget?: number;
}

export interface TrackOptions {
  event?: string;
  resource?: string;
  detail?: string;
}

export interface SessionSummary {
  sessionId: string;
  room: string;
  agentId: string;
  startedAt: number;
  endedAt: number | null;
  tokenLimit: number;
  tokensUsed: number;
  skillLoads: number;
  denials: number;
  status: string;
  summary: string;
}

const SKILL_LOAD_EVENTS = new Set(["context_load", "skill_load", "skill_loaded"]);
const DENIAL_EVENTS = new Set(["denial", "denied", "skill_access_denied"]);

// ── Session tracker ──────────────────────────────────────────────────────────

export class SessionTracker {
  readonly env: Environment;
  readonly sessionId: string;
  private readonly clock: () => number;
  private readonly dir: string;

  constructor(options: { env: Environment; sessionId?: string; clock?: () => number }) {
    this.env = options.env;
    this.sessionId = options.sessionId ?? newSessionId();
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this.dir = join(options.env.sessionsDir, this.sessionId);
  }

  get stateFile(): string {
    return join(this.dir, "state.json");
  }
  get eventLog(): string {
    return join(this.dir, "events.jsonl");
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Initialize a session and write its state.json. */
  start(room: string, options: StartOptions = {}): SessionState {
    this.ensureDir();
    const cfg = this.env.config;
    const capabilities = cfg.roomCapabilities(room);
    const allowedSkills = [...cfg.roomSkillSet(room)];
    const mcpServers = cfg.roomMcpServers(room);
    const budget = options.budget ?? cfg.roomBudget(room);
    const now = this.clock();

    const state: SessionState = {
      sessionId: this.sessionId,
      room,
      agentId: options.agentId ?? "",
      startedAt: now,
      startedIso: new Date(now * 1000).toISOString(),
      tokenLimit: budget,
      tokensUsed: 0,
      tokensRemaining: budget,
      capabilities: [...capabilities].sort(),
      allowedSkills: allowedSkills.slice(0, 100), // cap for JSON size
      allowedSkillsCount: allowedSkills.length,
      allowedMcpServers: mcpServers,
      status: "active",
      events: 0,
    };

    this.writeState(state);
    this.logEvent("session_started", { room, budget });

    // Mirror to the isolation audit trail.
    const session = new AgentSession({ room, agentId: state.agentId, capabilities });
    auditLog(this.env, session, {
      event: "session_started",
      decision: "allowed",
      reason: `budget=${budget}`,
    });
    return state;
  }

  /** Record a context-load event and debit the budget. Returns false if no session. */
  track(key: string, tokens: number, options: TrackOptions = {}): boolean {
    const state = this.readState();
    if (!state) return false;

    state.tokensUsed += tokens;
    state.tokensRemaining = Math.max(0, state.tokenLimit - state.tokensUsed);
    state.events += 1;
    if (state.tokensRemaining <= 0) state.status = "budget_exceeded";

    this.writeState(state);
    this.logEvent(options.event ?? "context_load", {
      key,
      tokens,
      resource: options.resource ?? "",
      budgetUsed: state.tokensUsed,
      budgetRemaining: state.tokensRemaining,
      detail: options.detail ?? "",
    });
    return true;
  }

  /** Record a denial event (does not change the budget). Returns false if no session. */
  trackDenial(skillName: string, reason: string): boolean {
    const state = this.readState();
    if (!state) return false;
    state.events += 1;
    this.writeState(state);
    this.logEvent("denial", { key: skillName, tokens: 0, detail: reason });
    return true;
  }

  /** Check budget and room-skill gating. */
  canLoad(tokens: number, skillName = ""): { ok: boolean; reason: string } {
    const state = this.readState();
    if (!state) return { ok: false, reason: "no session state" };
    if (state.tokensRemaining < tokens) {
      return {
        ok: false,
        reason: `budget exceeded: need ${tokens}, have ${state.tokensRemaining}`,
      };
    }
    if (skillName && state.allowedSkills.length > 0 && !state.allowedSkills.includes(skillName)) {
      return { ok: false, reason: `skill '${skillName}' not in room '${state.room}'` };
    }
    return { ok: true, reason: "ok" };
  }

  /** Finalize the session and roll it up to SQLite. */
  end(status = "completed", summary = ""): SessionState | null {
    const state = this.readState();
    if (!state) return null;

    const now = this.clock();
    state.status = status;
    state.endedAt = now;
    state.endedIso = new Date(now * 1000).toISOString();
    state.summary = summary;
    this.writeState(state);
    this.logEvent("session_ended", { status, summary });

    this.rollup(state);

    const session = new AgentSession({ room: state.room });
    auditLog(this.env, session, {
      event: "session_ended",
      decision: "allowed",
      reason: `tokens=${state.tokensUsed} status=${status}`,
    });
    return state;
  }

  // ── Internals ─────────────────────────────────────────────────────────--
  private readState(): SessionState | null {
    if (!existsSync(this.stateFile)) return null;
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as SessionState;
    } catch {
      return null;
    }
  }

  private writeState(state: SessionState): void {
    this.ensureDir();
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  private logEvent(event: string, data: Record<string, unknown>): void {
    this.ensureDir();
    const entry = { timestamp: this.clock(), event, ...data };
    appendFileSync(this.eventLog, JSON.stringify(entry) + "\n");
  }

  private rollup(state: SessionState): void {
    let skillLoads = 0;
    let denials = 0;
    const events = this.readEvents();
    for (const evt of events) {
      const name = typeof evt.event === "string" ? evt.event : "";
      if (SKILL_LOAD_EVENTS.has(name)) skillLoads += 1;
      if (DENIAL_EVENTS.has(name)) denials += 1;
    }

    const db = openSessionsDb(this.env);
    try {
      db.query(
        `INSERT OR REPLACE INTO sessions
           (id, room, agent_id, token_limit, tokens_used, skill_loads, denials,
            started_at, ended_at, status, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        state.sessionId,
        state.room,
        state.agentId,
        state.tokenLimit,
        state.tokensUsed,
        skillLoads,
        denials,
        state.startedAt,
        state.endedAt ?? this.clock(),
        state.status,
        state.summary ?? "",
      );

      const insertEvent = db.query(
        `INSERT INTO session_events (session_id, timestamp, event, key, tokens, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const evt of events) {
        insertEvent.run(
          this.sessionId,
          typeof evt.timestamp === "number" ? evt.timestamp : this.clock(),
          typeof evt.event === "string" ? evt.event : "",
          typeof evt.key === "string" ? evt.key : "",
          typeof evt.tokens === "number" ? evt.tokens : 0,
          typeof evt.detail === "string" ? evt.detail : "",
        );
      }
    } finally {
      db.close();
    }
  }

  private readEvents(): Array<Record<string, unknown>> {
    if (!existsSync(this.eventLog)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const line of readFileSync(this.eventLog, "utf8").trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // skip malformed lines
      }
    }
    return out;
  }
}

// ── Schema + queries ─────────────────────────────────────────────────────────

const SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    token_limit INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    skill_loads INTEGER NOT NULL DEFAULT 0,
    denials INTEGER NOT NULL DEFAULT 0,
    started_at REAL NOT NULL,
    ended_at REAL,
    status TEXT NOT NULL DEFAULT 'active',
    summary TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp REAL NOT NULL,
    event TEXT NOT NULL,
    key TEXT NOT NULL DEFAULT '',
    tokens INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_session_events ON session_events(session_id);
`;

function openSessionsDb(env: Environment): Database {
  mkdirSync(env.stateDir, { recursive: true });
  const db = new Database(env.sessionsDb);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SESSIONS_SCHEMA);
  return db;
}

interface SessionRow {
  id: string;
  room: string;
  agent_id: string;
  token_limit: number;
  tokens_used: number;
  skill_loads: number;
  denials: number;
  started_at: number;
  ended_at: number | null;
  status: string;
  summary: string;
}

function rowToSummary(r: SessionRow): SessionSummary {
  return {
    sessionId: r.id,
    room: r.room,
    agentId: r.agent_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    tokenLimit: r.token_limit,
    tokensUsed: r.tokens_used,
    skillLoads: r.skill_loads,
    denials: r.denials,
    status: r.status,
    summary: r.summary,
  };
}

/** List recent rolled-up sessions, optionally filtered by room. */
export function listSessions(
  env: Environment,
  options: { room?: string; limit?: number } = {},
): SessionSummary[] {
  if (!existsSync(env.sessionsDb)) return [];
  const limit = options.limit ?? 20;
  const db = openSessionsDb(env);
  try {
    const rows = options.room
      ? (db
          .query("SELECT * FROM sessions WHERE room = ? ORDER BY started_at DESC LIMIT ?")
          .all(options.room, limit) as SessionRow[])
      : (db
          .query("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
          .all(limit) as SessionRow[]);
    return rows.map(rowToSummary);
  } finally {
    db.close();
  }
}

/**
 * Find the most recent active session by reading the live state files.
 *
 * (The prototype sorted by directory name, which for random session ids is not
 * chronological; v1 sorts active sessions by `startedAt` descending.)
 */
export function activeSession(env: Environment): SessionState | null {
  const dir = env.sessionsDir;
  if (!existsSync(dir)) return null;
  const active: SessionState[] = [];
  for (const name of readdirSync(dir)) {
    const stateFile = join(dir, name, "state.json");
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as SessionState;
      if (state.status === "active") active.push(state);
    } catch {
      // skip unreadable state
    }
  }
  if (active.length === 0) return null;
  active.sort((a, b) => b.startedAt - a.startedAt);
  return active[0] ?? null;
}

function newSessionId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
