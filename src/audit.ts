/**
 * audit.ts — HYPERVISOR: audit trail + in-process event bus.
 *
 * A standalone, sessionId-keyed front door onto the Phase 1 isolation audit log
 * (`isolation.ts`). The `gate()` wrapper calls {@link audit.deny} automatically
 * on a room-skill denial; agent integrations call {@link audit.allow} /
 * {@link audit.deny} explicitly. Reads (`recent`, `denialsToday`) are thin
 * wrappers over the isolation queries.
 *
 * SPEC_TS §3.4 defines this primitive (no standalone Python equivalent — the
 * prototype only had `isolation.audit_log(env, session, ...)` which requires a
 * full AgentSession). Here the verbs take a `sessionId` string plus optional
 * `{ room }` scoping, matching the spec's call shapes:
 *   audit.deny(sessionId, 'read_skill', 'nda-review', 'not in room marketing')
 *   audit.allow(sessionId, 'read_skill', 'case-brief', 'loaded 1623 tokens')
 *   audit.recent({ room: 'marketing', limit: 10 })
 *   audit.denialsToday('marketing')
 *
 * Event bus: every hypervisor primitive emits a typed {@link HypervisorEvent}
 * through {@link emitHypervisorEvent}. The dashboard subscribes via
 * {@link onHypervisorEvent} and pushes them over the `/api/live` WebSocket
 * (Phase 2 established the endpoint; Phase 3 fills it with real events). This is
 * an in-process bus — it carries events within the process that owns the
 * hypervisor calls (the dashboard, an integration host). It is NOT cross-process
 * IPC; a spawn in another process is not observed here. Documented honestly per
 * BUILD_BRIEF §6.
 */
import {
  AgentSession,
  type AuditEntry,
  type Decision,
  auditDenialsToday,
  auditLog,
  auditRead,
} from "./isolation.ts";
import { Environment } from "./env.ts";

const nowSec = (): number => Date.now() / 1000;

// ── Event bus ──────────────────────────────────────────────────────────────--

/** Kinds of hypervisor event pushed to the live dashboard. */
export type HypervisorEventKind = "spawn" | "budget" | "gate" | "audit";

/** A single hypervisor event. A flexible envelope — fields populated per kind. */
export interface HypervisorEvent {
  kind: HypervisorEventKind;
  /** Sub-event, e.g. "started"/"completed" (spawn), "spent"/"exceeded" (budget). */
  event?: string;
  decision?: Decision;
  sessionId?: string;
  room?: string;
  capability?: string;
  resource?: string;
  reason?: string;
  command?: string;
  pid?: number;
  tokens?: number;
  used?: number;
  remaining?: number;
  limit?: number;
  /** Epoch seconds. */
  timestamp: number;
}

export type HypervisorEventListener = (event: HypervisorEvent) => void;

const listeners = new Set<HypervisorEventListener>();

/** Subscribe to hypervisor events. Returns an unsubscribe function. */
export function onHypervisorEvent(listener: HypervisorEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Emit a hypervisor event to all subscribers. Never throws into the caller. */
export function emitHypervisorEvent(event: HypervisorEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A bad subscriber must not break the primitive that emitted the event.
    }
  }
}

// ── Audit verbs ──────────────────────────────────────────────────────────────

/** Optional scoping/context for a write. `env` defaults to {@link Environment.default}. */
export interface AuditWriteOptions {
  room?: string;
  agentId?: string;
  env?: Environment;
}

/** A minimal AgentSession carrying just the identity columns the audit log needs. */
function sessionFor(sessionId: string, options: AuditWriteOptions): AgentSession {
  return new AgentSession({
    room: options.room ?? "",
    agentId: options.agentId ?? "",
    sessionId,
    capabilities: [],
  });
}

/** Record an allowed privileged operation. */
export function allow(
  sessionId: string,
  capability: string,
  resource: string,
  detail = "",
  options: AuditWriteOptions = {},
): void {
  const env = options.env ?? Environment.default();
  auditLog(env, sessionFor(sessionId, options), {
    event: "access_allowed",
    capability,
    resource,
    decision: "allowed",
    reason: detail,
  });
  emitHypervisorEvent({
    kind: "audit",
    decision: "allowed",
    sessionId,
    room: options.room ?? "",
    capability,
    resource,
    reason: detail,
    timestamp: nowSec(),
  });
}

/** Record a denied access attempt. */
export function deny(
  sessionId: string,
  capability: string,
  resource: string,
  reason = "",
  options: AuditWriteOptions = {},
): void {
  const env = options.env ?? Environment.default();
  auditLog(env, sessionFor(sessionId, options), {
    event: "access_denied",
    capability,
    resource,
    decision: "denied",
    reason,
  });
  emitHypervisorEvent({
    kind: "audit",
    decision: "denied",
    sessionId,
    room: options.room ?? "",
    capability,
    resource,
    reason,
    timestamp: nowSec(),
  });
}

/** Recent audit entries, optionally scoped to a room. */
export function recent(options: { room?: string; limit?: number; env?: Environment } = {}): AuditEntry[] {
  const env = options.env ?? Environment.default();
  return auditRead(env, {
    ...(options.room ? { room: options.room } : {}),
    ...(options.limit != null ? { limit: options.limit } : {}),
  });
}

/** Count today's denials, optionally scoped to a room. */
export function denialsToday(room?: string, options: { env?: Environment } = {}): number {
  const env = options.env ?? Environment.default();
  return auditDenialsToday(env, room);
}

/**
 * The `audit` namespace object (the spec's call shape: `audit.deny(...)`,
 * `audit.recent(...)`). The bare functions are also exported for tree-shaking.
 */
export const audit = { allow, deny, recent, denialsToday } as const;
