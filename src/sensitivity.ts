/**
 * sensitivity.ts — Sensitivity labels and token ceilings (pure logic).
 *
 * Rooms decide WHO may reach a skill; a label decides whether a particular
 * CALLER may be handed it. A token can carry a ceiling (`--max-sensitivity`); a
 * skill above that ceiling is never delivered to it, and is hidden from its
 * lists, searches and routing. This is how a person's own (bring-your-own) agent
 * is kept from receiving what the person's house-agent sessions may.
 *
 *     public  <  internal  <  restricted
 *
 * Where a label comes from, most specific first:
 *   1. `[skills.skill_sensitivity] <skill> = "..."`   the operator's per-skill override
 *   2. `[skills.rooms.<room>] sensitivity = "..."`    the room's default
 * A skill matching neither is UNLABELED. There is deliberately no third source:
 * a label written inside the skill's own SKILL.md would be chosen by whoever
 * authored or installed the skill — including through a proposal — which is the
 * party a label must not trust.
 *
 * Two fail-closed rules:
 *   - a token WITH a ceiling is never handed an UNLABELED skill;
 *   - a label that is present but not a valid tier counts as `restricted`.
 * A token with NO ceiling is unaffected (the house agent, and every token issued
 * before labels existed).
 */
import type { Config } from "./config.ts";

export type Sensitivity = "public" | "internal" | "restricted";

export const SENSITIVITIES: readonly Sensitivity[] = ["public", "internal", "restricted"];

const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, restricted: 2 };

export function isSensitivity(v: unknown): v is Sensitivity {
  return typeof v === "string" && (SENSITIVITIES as readonly string[]).includes(v);
}

export function sensitivityRank(s: Sensitivity): number {
  return RANK[s];
}

/**
 * A configured value as a label: a valid tier is itself, ABSENT is null
 * (unlabeled), and anything else present-but-wrong (a typo, a number) is
 * `restricted` — a mistake must never make a skill MORE available.
 */
export function coerceLabel(v: unknown): Sensitivity | null {
  if (v === undefined || v === null) return null;
  return isSensitivity(v) ? v : "restricted";
}

/** Is the raw configured value present but not a valid tier? (For reports.) */
export function isInvalidLabel(v: unknown): boolean {
  return v !== undefined && v !== null && !isSensitivity(v);
}

/**
 * The label a skill has for a session in `room`: the operator's per-skill
 * override, else the room's default, else null (unlabeled).
 *
 * A skill the room does not itself list (reachable only through an approved
 * cross-room grant) has no meaningful label from THIS room's default, so it takes
 * the strictest label of the rooms that do list it — and is unlabeled if any of
 * them is.
 */
export function effectiveSensitivity(config: Config, room: string, skill: string): Sensitivity | null {
  const override = config.skillSensitivityRaw(skill);
  if (override !== undefined && override !== null) return coerceLabel(override);

  const rooms = config.roomSkills;
  const own = rooms[room]?.skills ?? [];
  if (own.length === 0 || own.includes(skill)) return coerceLabel(config.roomSensitivityRaw(room));

  let strictest: Sensitivity | null = null;
  let any = false;
  for (const [name, r] of Object.entries(rooms)) {
    if (!(r.skills ?? []).includes(skill)) continue;
    any = true;
    const label = coerceLabel(config.roomSensitivityRaw(name));
    if (label === null) return null;
    if (strictest === null || RANK[label] > RANK[strictest]) strictest = label;
  }
  return any ? strictest : null;
}

/** May a caller with `ceiling` receive a skill labelled `label`? No ceiling ⇒ yes; unlabeled under a ceiling ⇒ no. */
export function withinCeiling(label: Sensitivity | null, ceiling: Sensitivity | null): boolean {
  if (ceiling === null) return true;
  if (label === null) return false;
  return RANK[label] <= RANK[ceiling];
}

/** The audit-row reason for a sensitivity denial. The one place its wording is defined. */
export function denialReason(skill: string, label: Sensitivity | null, ceiling: Sensitivity): string {
  return `skill '${skill}' is ${label ?? "unlabeled"}; this token's ceiling is ${ceiling}`;
}

const DENIAL_RE = /^skill '(.*)' is (?:public|internal|restricted|unlabeled); this token's ceiling is (?:public|internal|restricted)$/;

/**
 * What an AGENT may be shown of an audit reason. A sensitivity denial is worded as
 * an out-of-room refusal, exactly as the denial itself was, so reading the audit
 * log back cannot reveal that a name exists above the caller's ceiling.
 */
export function agentFacingReason(reason: string, room: string): string {
  const m = DENIAL_RE.exec(reason);
  return m ? `skill '${m[1]}' not in room '${room}'` : reason;
}
