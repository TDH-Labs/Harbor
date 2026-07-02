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
 * so the session is ambient — but ambient PER ASYNC CALL CHAIN, not process-wide.
 * Bind it with {@link runWithGateContext}, which carries the context through every
 * `await` via AsyncLocalStorage; Pi and the MCP server wrap each per-session
 * request handler in it, so concurrent sessions interleaved in one process never
 * read each other's context (the earlier mutable module-global context could be
 * clobbered by a second session mid-call and fail OPEN — see
 * `gate — concurrent session context isolation` in `gate.test.ts`). With no bound
 * scope, context is resolved from the `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION` env
 * vars (the vars `spawn()` injects) — the single-session-per-process fallback.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import {
  AccessDenied,
  AgentSession,
  Capability,
} from "./isolation.ts";
import { Environment } from "./env.ts";
import { deny, emitHypervisorEvent } from "./audit.ts";

/** Contract-named alias for the isolation error (BUILD_BRIEF / phase interface). */
export { AccessDenied as AccessDeniedError } from "./isolation.ts";

const nowSec = (): number => Date.now() / 1000;

/** Tools whose first argument is a skill name and so get room-skill allowlist gating. */
const SKILL_GATED_TOOLS = new Set<string>(["read_skill", "read_skill_digest"]);

/**
 * Tools whose first argument is an optional ROOM OVERRIDE (list-shaped tools:
 * "show me another room's pool"). A room override differing from the session's
 * own room is a cross-room enumeration and is permitted only for an ADMIN
 * session (REVIEW_06.md finding #5). This mirrors the guard `ab47ef7` (B1)
 * added inside each integration's own `listSkillsImpl` — but hardens it AT THE
 * PRIMITIVE instead of only inside those two hand-written functions, so a
 * future caller that wires `gate('list_skills', (room) => listSkills(env,
 * room))` directly inherits the check structurally instead of needing to
 * reimplement it (and risking the exact hole B1 fixed reopening at a new call
 * site with no test to catch it).
 *
 * HARD REQUIREMENT for any tool name added to this set: the gate below reads
 * `args[0]` UNCONDITIONALLY as the room-override string the instant a tool
 * name is in this set (see the `override = args[0] as string | undefined`
 * cast a few lines down) — there is no further check that `args[0]` actually
 * *is* a room name. A tool whose first parameter is anything else (a skill
 * name, an id, a flag, an options object) must NOT be added here: its first
 * argument would be silently reinterpreted as a room to enumerate, which
 * either wrongly denies a legitimate call (the value doesn't match the
 * session's room and isn't ADMIN) or — worse — wrongly allows one, if the
 * value happens to coincidentally equal the caller's own room string. Only
 * add a tool once its wrapped function's signature is confirmed to be
 * `(room?: string, ...)`, matching the two real callers today:
 * `integrations/mcp-server.ts` and `integrations/pi.ts`, both wiring
 * `gate("list_skills", listSkillsImpl)` where `listSkillsImpl(roomOverride?:
 * string)`.
 */
const ROOM_OVERRIDE_GATED_TOOLS = new Set<string>(["list_skills"]);

/** Ambient gate context: which session/environment wrapped calls run under. */
export interface GateContext {
  env: Environment;
  session: AgentSession;
}

/**
 * The active gate context, carried by AsyncLocalStorage so each async call chain
 * has its OWN context. This replaces a mutable module-global slot: there is no
 * shared cell for a second session to overwrite, so two concurrent gated calls
 * for different sessions can NEVER read each other's context. The gate therefore
 * cannot be raced into evaluating the wrong session — the fail-open is structural-
 * ly impossible, not merely improbable.
 */
const gateContextStore = new AsyncLocalStorage<GateContext>();

/**
 * Env-var fallback sessions, memoized by `room:sessionId`. Used ONLY when no
 * {@link runWithGateContext} scope is active — i.e. a single-session-per-process
 * spawn resolving its identity from `AGENT_ENV_ROOM`/`AGENT_ENV_SESSION` (the
 * vars `spawn()` injects). Keyed, not a single slot, so distinct identities never
 * alias. This path is NOT for concurrent in-process sessions: env vars are
 * process-global and cannot represent two identities at once, so a process that
 * hosts multiple sessions must bind each explicitly via `runWithGateContext`.
 */
const envVarSessions = new Map<string, AgentSession>();

/**
 * Run `callback` with `context` bound as the active gate context for the entire
 * async call chain it starts. Concurrency-safe replacement for a mutable module
 * global: nested and overlapping scopes each carry their own context across every
 * `await`, so interleaved sessions never cross. Returns whatever `callback`
 * returns (its value, or its promise for an async callback).
 *
 *   await runWithGateContext({ env, session }, () => read_skill('nda-review'));
 *
 * Pi and the MCP server wrap each per-session request handler in this, so every
 * gated call inside resolves against that session even with many sessions
 * interleaved in one process.
 */
export function runWithGateContext<T>(context: GateContext, callback: () => T): T {
  return gateContextStore.run(context, callback);
}

/**
 * Resolve the active gate context: the context bound by an enclosing
 * {@link runWithGateContext} scope if there is one, else resolved from the
 * `AGENT_ENV_ROOM`/`AGENT_ENV_SESSION` env vars (memoized). The env-var path is
 * the single-session-per-process fallback; concurrent sessions bind explicitly.
 */
export function currentGateContext(): GateContext {
  const bound = gateContextStore.getStore();
  if (bound) return bound;
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

    // 3. Room-override check for tools whose first arg is an optional room
    // name to enumerate (e.g. `list_skills(room?)`). A caller may always see
    // their own room; asking for a DIFFERENT room requires ADMIN.
    if (ROOM_OVERRIDE_GATED_TOOLS.has(tool)) {
      const override = args[0] as string | undefined;
      if (override && override !== session.room && !session.has(Capability.ADMIN)) {
        const reason = `room '${session.room}' may not access room '${override}' via '${tool}'`;
        deny(session.sessionId, tool, override, reason, {
          room: session.room,
          agentId: session.agentId,
          env,
        });
        emitHypervisorEvent({
          kind: "gate",
          event: "room_override_denied",
          decision: "denied",
          sessionId: session.sessionId,
          room: session.room,
          capability: tool,
          resource: override,
          reason,
          timestamp: nowSec(),
        });
        throw new AccessDenied(reason, { session, capability: tool, resource: override });
      }
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
