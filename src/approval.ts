/**
 * approval.ts — Human-in-the-loop approval for a cross-room skill load.
 *
 * Today a request for a skill outside the session's room is a silent denial.
 * This turns that wall into a doorbell: the request pauses, a human is asked,
 * and a YES becomes a TIME-BOXED grant scoped to exactly that
 * (session, room, resource). docs/SPEC_hardening.md step 2.
 *
 * FAIL CLOSED IS THE WHOLE DESIGN. Every path that is not an explicit,
 * unexpired, correctly-scoped approval is a denial:
 *
 *   - transport throws                 → deny
 *   - transport times out              → deny
 *   - transport returns a malformed    → deny
 *     decision, or `granted` non-true
 *   - grant expired, or expiry absent  → deny
 *   - grant for another session /      → deny
 *     room / resource
 *   - no transport configured          → deny (the DEFAULT is `deny`)
 *
 * There is deliberately NO "allow on error" branch anywhere in this file, and
 * no way to express a permanent grant: {@link MAX_GRANT_SECONDS} caps every
 * approval, including one a transport tries to hand back with a far-future
 * expiry.
 *
 * WHY THE TRANSPORT IS OUT OF BAND: the MCP server owns stdin/stdout for
 * JSON-RPC framing, so it cannot prompt there — writing a prompt to stdout
 * corrupts the protocol stream. Approval therefore travels a side channel
 * (a file, a socket, a push), which is why this is an interface rather than a
 * `readline` call.
 *
 * HONEST SCOPE: this gates the MCP TOOL PATH. It does not stop an agent that
 * can read the skill file directly off disk — that needs pool isolation
 * (spec step 3/4). Approval buys a decision point and an audit trail, not
 * containment.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Database } from "bun:sqlite";

import { openDb } from "./db.ts";
import type { Environment } from "./env.ts";

/** Hard ceiling on any grant, however long a transport asks for. */
export const MAX_GRANT_SECONDS = 3600;

/** Default wait before an unanswered request is denied. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** What the human is being asked to approve. */
export interface ApprovalRequest {
  sessionId: string;
  /** The room the session is scoped to. */
  room: string;
  tool: string;
  /** The skill (or other resource) being requested. */
  resource: string;
  /** The room the resource actually belongs to, when known. */
  targetRoom: string;
  /** Why the gate fired, in human terms. */
  reason: string;
}

/** A transport's answer. Anything not explicitly `granted: true` is a denial. */
export interface ApprovalDecision {
  granted: boolean;
  /** Epoch seconds. Absent ⇒ denied: a grant with no expiry is never honored. */
  expiresAt?: number;
  approver?: string;
}

export interface ApprovalTransport {
  readonly name: string;
  request(req: ApprovalRequest, timeoutMs: number): Promise<ApprovalDecision>;
}

/**
 * The default transport: deny, immediately, without asking anyone.
 *
 * This is what makes shipping the feature non-breaking — behavior is identical
 * to today until a room opts in. It is also the correct fallback for a headless
 * or unattended run, where there is no human to ask.
 */
export const denyTransport: ApprovalTransport = {
  name: "deny",
  async request(): Promise<ApprovalDecision> {
    return { granted: false };
  },
};

// ── Grant store ──────────────────────────────────────────────────────────────

const GRANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS approval_grants (
  session_id  TEXT NOT NULL,
  room        TEXT NOT NULL,
  resource    TEXT NOT NULL,
  expires_at  REAL NOT NULL,
  approver    TEXT NOT NULL DEFAULT '',
  granted_at  REAL NOT NULL,
  PRIMARY KEY (session_id, room, resource)
);
`;

function grantDb(env: Environment): Database {
  const path = env.isolationDb;
  mkdirSync(dirname(path), { recursive: true });
  // `isolationDb` is the SAME physical file isolation.ts's own auditDb() uses,
  // and db.ts's cache runs `init` only on the FIRST open of a given path —
  // whichever module opens it first wins, the other's init is silently
  // skipped. Relying on `openDb`'s init to create GRANT_SCHEMA was exactly
  // this bug: when audit logging opened the connection first (the common
  // case), approval_grants never got created and every query threw "no such
  // table". Fix: run the idempotent `CREATE TABLE IF NOT EXISTS` unconditionally
  // after opening, not only inside `init` — cheap, and correct regardless of
  // open order.
  const db = openDb(path, (d) => {
    d.exec("PRAGMA busy_timeout = 5000");
    d.exec("PRAGMA journal_mode = WAL");
  }).db;
  db.exec(GRANT_SCHEMA);
  return db;
}

/** A stored grant, as read back. */
export interface StoredGrant {
  sessionId: string;
  room: string;
  resource: string;
  expiresAt: number;
  approver: string;
}

/**
 * Persist a grant, clamped to {@link MAX_GRANT_SECONDS}.
 *
 * The clamp is applied HERE rather than trusting the transport, so a
 * compromised or buggy transport cannot mint a decade-long approval.
 */
export function saveGrant(
  env: Environment,
  req: ApprovalRequest,
  decision: ApprovalDecision,
  now: number = Date.now() / 1000,
): StoredGrant {
  const requested = decision.expiresAt ?? 0;
  const ceiling = now + MAX_GRANT_SECONDS;
  const expiresAt = Math.min(requested, ceiling);
  const grant: StoredGrant = {
    sessionId: req.sessionId,
    room: req.room,
    resource: req.resource,
    expiresAt,
    approver: decision.approver ?? "",
  };
  grantDb(env)
    .query(
      `INSERT OR REPLACE INTO approval_grants
         (session_id, room, resource, expires_at, approver, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(grant.sessionId, grant.room, grant.resource, grant.expiresAt, grant.approver, now);
  return grant;
}

/**
 * Is there a live grant for exactly this (session, room, resource)?
 *
 * Scoping is exact on all three columns — a grant for one skill never covers
 * another, and a grant issued to one session never covers a different one.
 * An expired row returns false and is left for {@link purgeExpiredGrants};
 * expiry is evaluated on READ so a clock-forward cannot resurrect it.
 */
export function hasLiveGrant(
  env: Environment,
  sessionId: string,
  room: string,
  resource: string,
  now: number = Date.now() / 1000,
): boolean {
  const row = grantDb(env)
    .query(
      `SELECT expires_at FROM approval_grants
        WHERE session_id = ? AND room = ? AND resource = ?`,
    )
    .get(sessionId, room, resource) as { expires_at: number } | null;
  if (!row) return false;
  return row.expires_at > now;
}

/** Delete every expired grant. Returns how many rows went. */
export function purgeExpiredGrants(env: Environment, now: number = Date.now() / 1000): number {
  const db = grantDb(env);
  const before = (db.query("SELECT COUNT(*) AS n FROM approval_grants").get() as { n: number }).n;
  db.query("DELETE FROM approval_grants WHERE expires_at <= ?").run(now);
  const after = (db.query("SELECT COUNT(*) AS n FROM approval_grants").get() as { n: number }).n;
  return before - after;
}

/** Every live grant, for `harbor approval list`. */
export function listGrants(env: Environment, now: number = Date.now() / 1000): StoredGrant[] {
  const rows = grantDb(env)
    .query(
      `SELECT session_id, room, resource, expires_at, approver
         FROM approval_grants WHERE expires_at > ? ORDER BY expires_at`,
    )
    .all(now) as Array<{
    session_id: string;
    room: string;
    resource: string;
    expires_at: number;
    approver: string;
  }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    room: r.room,
    resource: r.resource,
    expiresAt: r.expires_at,
    approver: r.approver,
  }));
}

// ── The decision ─────────────────────────────────────────────────────────────

export interface ApprovalOutcome {
  granted: boolean;
  /** Why — always populated, and always audited by the caller. */
  reason: string;
  /** Set when an existing grant answered without asking a human again. */
  fromExistingGrant?: boolean;
  expiresAt?: number;
}

/**
 * Validate a transport's answer. Separated out and exported so the pen tests
 * can hammer it directly with hostile shapes.
 *
 * Returns null when the decision is acceptable; otherwise the denial reason.
 * Anything unparseable, non-true, expiry-less, or already-expired is refused.
 */
export function rejectDecision(
  decision: unknown,
  now: number = Date.now() / 1000,
): string | null {
  if (decision === null || typeof decision !== "object") return "transport returned a non-object decision";
  const d = decision as Record<string, unknown>;
  // Strictly `true` — a truthy 1 / "yes" / {} must not pass for an approval.
  if (d.granted !== true) return "not granted";
  if (typeof d.expiresAt !== "number" || !Number.isFinite(d.expiresAt)) {
    return "grant has no finite expiry — refusing an unbounded approval";
  }
  if (d.expiresAt <= now) return "grant already expired";
  return null;
}

/**
 * Ask for approval, honoring an existing live grant first.
 *
 * EVERY non-approval path returns `granted: false` with a reason. The caller
 * (gate.ts) audits the outcome either way.
 */
export async function requestApproval(
  env: Environment,
  req: ApprovalRequest,
  transport: ApprovalTransport = denyTransport,
  options: { timeoutMs?: number; now?: number } = {},
): Promise<ApprovalOutcome> {
  const now = options.now ?? Date.now() / 1000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (hasLiveGrant(env, req.sessionId, req.room, req.resource, now)) {
    return { granted: true, reason: "existing live grant", fromExistingGrant: true };
  }

  let decision: unknown;
  try {
    decision = await withTimeout(transport.request(req, timeoutMs), timeoutMs);
  } catch (err) {
    // Timeout, throw, rejection — all the same answer.
    const why = err instanceof Error ? err.message : String(err);
    return { granted: false, reason: `approval transport failed: ${why}` };
  }

  const rejection = rejectDecision(decision, now);
  if (rejection) return { granted: false, reason: rejection };

  const grant = saveGrant(env, req, decision as ApprovalDecision, now);
  return { granted: true, reason: "approved", expiresAt: grant.expiresAt };
}

/** Reject after `ms`. A transport that never settles must not hang the gate. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
