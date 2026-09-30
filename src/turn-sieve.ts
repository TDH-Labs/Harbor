/**
 * turn-sieve.ts — Session-scoped Turn-Sieve: "which of MY room's skills does
 * this turn need?"
 *
 * `skills.ts#routeSkillsForTurn` is the pure router (untrusted-daemon safe,
 * capped, deterministic fallback). This is the layer both agent integrations
 * (MCP server, Pi) share so they cannot drift: it resolves the room the session
 * may look at, hands the router ONLY that room's skills, audits the outcome, and
 * renders the lean answer an agent should see.
 *
 * Harbor cannot rewrite a client's prompt in flight — MCP has no such hook — so
 * the Turn-Sieve is pull-based: the agent calls `route_skills` at the start of a
 * task (or when the topic changes) and then `activate_skill`s what it names.
 * The tool description says so; nothing here pretends to intercept turns.
 */
import { audit } from "./audit.ts";
import type { GateContext } from "./gate.ts";
import { Capability } from "./isolation.ts";
import { listSkills, routeSkillsForTurn, sieveLimits, type TurnSieveResult } from "./skills.ts";

export interface RouteTurnResult {
  /** False when the request itself was refused (e.g. a cross-room override). */
  ok: boolean;
  /** Agent-facing text. */
  text: string;
  room: string;
  /** Present when routing ran. */
  sieve?: TurnSieveResult;
  availableCount?: number;
}

/**
 * Route `prompt` for the session in `ctx`. `roomOverride` follows the same rule
 * as `search_skills` / `list_skills`: another room requires ADMIN.
 */
export async function routeTurn(
  ctx: GateContext,
  prompt: string,
  roomOverride?: string,
  options: {
    /**
     * Honor `[system_one] url` from the session's own config (default true).
     * A multi-tenant server passes false: a URL a tenant can edit would make the
     * server send requests to any host it names (SSRF, and a port-scan oracle
     * through the reported failure reason). The operator-level
     * `HARBOR_SYSTEM_ONE_URL` still applies.
     */
    trustConfigUrl?: boolean;
  } = {},
): Promise<RouteTurnResult> {
  const { env, session } = ctx;

  if (roomOverride && roomOverride !== session.room && !session.has(Capability.ADMIN)) {
    const reason = `room '${session.room}' may not route skills for room '${roomOverride}'`;
    audit.deny(session.sessionId, "route_skills", roomOverride, reason, { room: session.room, agentId: session.agentId, env });
    return { ok: false, text: `access denied: ${reason}.`, room: roomOverride };
  }
  const room = roomOverride ?? session.room;

  const available = listSkills(env, room);
  const so = env.config.systemOne;
  const sieve = await routeSkillsForTurn(prompt, room, available, {
    timeoutMs: so.timeoutMs,
    maxSkills: so.maxSkills,
    escalatedMaxSkills: so.escalatedMaxSkills,
    ...(so.url && (options.trustConfigUrl ?? true) ? { configUrl: so.url } : {}),
  });

  // A router that names skills outside the room is anomalous: record it as a
  // denial (server-side only — the names are never shown to the agent).
  if (sieve.dropped.length > 0) {
    audit.deny(
      session.sessionId,
      "route_skills",
      "system-one",
      `router named ${sieve.dropped.length} skill(s) outside room '${room}'; discarded`,
      { room: session.room, agentId: session.agentId, env },
    );
  }
  audit.allow(
    session.sessionId,
    "route_skills",
    room,
    `${sieve.selectedSkills.length}/${available.length} skill(s) via ${sieve.source}`,
    { room: session.room, agentId: session.agentId, env },
  );

  return {
    ok: true,
    text: formatTurnRoute(room, sieve, {
      availableCount: available.length,
      descriptions: new Map(available.map((s) => [s.name, s.description])),
      limits: sieveLimits(so.maxSkills, so.escalatedMaxSkills),
    }),
    room,
    sieve,
    availableCount: available.length,
  };
}

/** The lean, agent-facing rendering of a routing result. */
export function formatTurnRoute(
  room: string,
  sieve: TurnSieveResult,
  context: {
    availableCount: number;
    /** skill name → one-line description, for the room's skills. */
    descriptions?: ReadonlyMap<string, string>;
    limits?: { base: number; escalated: number };
  },
): string {
  const { availableCount, descriptions } = context;
  const limits = context.limits ?? sieveLimits();
  const via =
    sieve.source === "system-one"
      ? "System One"
      : `keyword match${sieve.fallbackReason ? ` (System One unavailable: ${sieve.fallbackReason})` : ""}`;

  if (availableCount === 0) return `No skills are available in room '${room}'.`;
  if (sieve.selectedSkills.length === 0) {
    return (
      `No skill in room '${room}' clearly fits this turn (via ${via}). ` +
      `Proceed without one, or try search_skills with different words.`
    );
  }

  const lines = [
    `Skills for this turn — room '${room}', via ${via}: ` +
      `${sieve.selectedSkills.length} of ${availableCount} selected, ~${sieve.promptTokenSavingsPct}% of the room's skills left out.`,
    "",
  ];
  for (const name of sieve.selectedSkills) {
    const desc = descriptions?.get(name);
    lines.push(`- ${name}${desc ? `: ${desc}` : ""}`);
  }
  if (sieve.selectedTools.length > 0) {
    lines.push("", `Tools these skills recommend: ${sieve.selectedTools.join(", ")}`);
  }
  if (sieve.crossDomain) {
    lines.push("", `This turn spans domains, so up to ${limits.escalated} skills were allowed.`);
  }
  lines.push("", "Load them one at a time with activate_skill({ skill_name: '<name>' }).");
  return lines.join("\n");
}
