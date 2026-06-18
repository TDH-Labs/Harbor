/**
 * gate.ts — HYPERVISOR: room-gated tool access wrapper.
 *
 * `gate(toolName, fn)` returns a wrapped function with the SAME signature that,
 * when called, enforces the current session's capability + room-skill gating
 * before `fn` runs. This is the enforcement boundary that replaces the execSync
 * bridge: an agent integration wraps each tool function once and every call is
 * checked in-process.
 *
 *   const read_skill = gate('read_skill', async (name) => loadSkillFile(name));
 *   // read_skill('nda-review') from a marketing session → throws AccessDenied
 *
 * SPEC_TS §3.3 defines this primitive. It composes Phase 1 isolation:
 *   - Capability check via `AgentSession.check(toolName, …, env)`, which throws
 *     {@link AccessDeniedError} AND writes the denial to the audit log.
 *   - For skill-loading tools, an additional room-skill allowlist check
 *     (`roomSkillAllowed`) — a marketing session cannot load a legal skill even
 *     if it somehow held `read_skill`. This denial is audited via `audit.deny`.
 * Denials are audited automatically; allowances are not (matching the prototype's
 * `require_capability`, which only records denials — successful loads are tracked
 * through the budget/session path instead).
 *
 * Session context: the wrapped signature has no room to add a session argument,
 * so the session is ambient. Set it once with {@link setGateContext} (Pi / the
 * MCP server do this at session start). With no explicit context, it is resolved
 * from the `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION` env vars (the same vars
 * `spawn()` injects), memoized so repeated calls don't re-audit a session.
 */
import {
  AccessDenied,
  AgentSession,
  type Capability,
} from "./isolation.ts";
import { Environment } from "./env.ts";
import { deny, emitHypervisorEvent } from "./audit.ts";

/** Contract-named alias for the isolation error (BUILD_BRIEF / phase interface). */
export { AccessDenied as AccessDeniedError } from "./isolation.ts";

const nowSec = (): number => Date.now() / 1000;

/** Tools whose first argument is a skill name and so get room-skill allowlist gating. */
const SKILL_GATED_TOOLS = new Set<string>(["read_skill", "read_skill_digest"]);

/** Ambient gate context: which session/environment wrapped calls run under. */
export interface GateContext {
  env: Environment;
  session: AgentSession;
}

let explicitContext: GateContext | null = null;
const envVarSessions = new Map<string, AgentSession>();

/** Set (or clear, with `null`) the ambient session context for `gate()`. */
export function setGateContext(context: GateContext | null): void {
  explicitContext = context;
}

/** Resolve the active gate context: explicit if set, else from env vars (memoized). */
export function currentGateContext(): GateContext {
  if (explicitContext) return explicitContext;
  const env = Environment.default();
  const room = process.env.AGENT_ENV_ROOM ?? env.config.skillDefaultRoom;
  const sessionId = process.env.AGENT_ENV_SESSION ?? "";
  const memoKey = `${room}:${sessionId}`;
  let session = envVarSessions.get(memoKey);
  if (!session) {
    session = new AgentSession({
      room,
      capabilities: env.config.roomCapabilities(room),
      ...(sessionId ? { sessionId } : {}),
    });
    envVarSessions.set(memoKey, session);
  }
  return { env, session };
}

/**
 * Wrap a tool function with room-gated capability enforcement. The returned
 * function has the same arguments as `fn` and resolves to its result; it throws
 * {@link AccessDeniedError} (audited) when the active session may not run it.
 */
export function gate<A extends unknown[], R>(
  toolName: Capability | string,
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  const tool = String(toolName);
  return async (...args: A): Promise<R> => {
    const { env, session } = currentGateContext();
    const skillGated = SKILL_GATED_TOOLS.has(tool);
    const resource = skillGated ? String(args[0] ?? "") : "";

    // 1. Capability check — throws AccessDenied and audits the denial itself.
    try {
      session.check(tool, resource, env);
    } catch (err) {
      emitHypervisorEvent({
        kind: "gate",
        event: "capability_denied",
        decision: "denied",
        sessionId: session.sessionId,
        room: session.room,
        capability: tool,
        resource,
        timestamp: nowSec(),
      });
      throw err;
    }

    // 2. Room-skill allowlist check for skill-loading tools.
    if (skillGated && resource && !session.roomSkillAllowed(env, resource)) {
      const reason = `skill '${resource}' not in room '${session.room}'`;
      deny(session.sessionId, tool, resource, reason, {
        room: session.room,
        agentId: session.agentId,
        env,
      });
      emitHypervisorEvent({
        kind: "gate",
        event: "room_skill_denied",
        decision: "denied",
        sessionId: session.sessionId,
        room: session.room,
        capability: tool,
        resource,
        reason,
        timestamp: nowSec(),
      });
      throw new AccessDenied(reason, { session, capability: tool, resource });
    }

    emitHypervisorEvent({
      kind: "gate",
      event: "allowed",
      decision: "allowed",
      sessionId: session.sessionId,
      room: session.room,
      capability: tool,
      resource,
      timestamp: nowSec(),
    });
    return await fn(...args);
  };
}
