/**
 * skill-assign.ts — Route orphan skills (in the pool but in no room) to rooms.
 *
 * Scans the pool for skills not assigned to any room, scores each against the
 * configured rooms by keyword overlap, and either reports suggestions, auto-
 * assigns to the best match, or assigns all to one room.
 *
 * De-personalization (BUILD_BRIEF §3 — the heaviest lift this phase): the Python
 * prototype hardcoded a `ROOM_SIGNALS` table keyed by one machine's specific set
 * of rooms, each with bespoke keyword weights. That bakes a single machine's room
 * taxonomy into the shipped code. Here the signals are DERIVED from config at
 * runtime — each room's
 * name, description, and already-assigned skill names are tokenized into weighted
 * keywords. The result generalizes to any room set a stranger configures and
 * preserves the prototype's documented intent ("keywords derived from its
 * description + skill names").
 *
 * Downstream contract: `assignOrphans(env, mode, options)` returns the
 * skill→room assignment map produced by the run.
 */
import type { Config } from "./config.ts";
import type { Environment } from "./env.ts";
import { addSkillToRoom, reloadEnv } from "./config-edit.ts";
import { computeAssignments, getAllSkillNames, getSkillDescription, findSkillDir } from "./skills.ts";

/** Words too generic to carry a room signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "by",
  "this", "that", "is", "are", "be", "use", "used", "using", "when", "via",
  "from", "into", "your", "you", "it", "its", "as", "at", "all", "any", "per",
  "room", "skill", "skills", "tool", "tools", "task", "tasks", "user", "says",
]);

export type AssignMode = "report" | "auto" | "room";

export interface AssignOptions {
  /** Target room for `mode: "room"`. */
  room?: string;
  /** Apply the assignments to config.toml (default true for auto/room). */
  write?: boolean;
}

export interface OrphanSuggestion {
  name: string;
  description: string;
  /** Rooms scored highest-first; empty when nothing matched. */
  scores: Array<{ room: string; score: number }>;
}

export interface AssignResult {
  mode: AssignMode;
  /** Skill → room actually assigned this run (empty in report mode). */
  assigned: Record<string, string>;
  /** Orphans considered, with their per-room scores. */
  orphans: OrphanSuggestion[];
}

// ── signal derivation ──────────────────────────────────────────────────────--

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9&+]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Build per-room keyword weights from config: a room's own name and assigned
 * skill names are strong signals (weight 4); words from its description are
 * weaker (weight 2). Repeated words accumulate. Pure function of config —
 * deterministic and machine-agnostic.
 */
export function deriveRoomSignals(config: Config): Record<string, Map<string, number>> {
  const signals: Record<string, Map<string, number>> = {};
  for (const [room, data] of Object.entries(config.roomSkills)) {
    const weights = new Map<string, number>();
    const add = (tokens: string[], weight: number) => {
      for (const t of tokens) weights.set(t, (weights.get(t) ?? 0) + weight);
    };
    add(tokenize(room), 4);
    for (const skill of data.skills ?? []) add(tokenize(skill), 4);
    add(tokenize(data.description ?? ""), 2);
    signals[room] = weights;
  }
  return signals;
}

/**
 * Score one skill against every room's signals by summing the weight of each
 * keyword that appears in the skill's name + description. Returns rooms with a
 * positive score, highest first.
 */
export function scoreSkillForRooms(
  skillName: string,
  description: string,
  signals: Record<string, Map<string, number>>,
): Array<{ room: string; score: number }> {
  const tokens = new Set(tokenize(`${skillName} ${description}`));
  const scored: Array<{ room: string; score: number }> = [];
  for (const [room, weights] of Object.entries(signals)) {
    let score = 0;
    for (const t of tokens) score += weights.get(t) ?? 0;
    if (score > 0) scored.push({ room, score });
  }
  scored.sort((a, b) => b.score - a.score || a.room.localeCompare(b.room));
  return scored;
}

// ── orphan discovery ───────────────────────────────────────────────────────--

/**
 * Skills present in the pool but assigned to no room (before the default-room
 * fallback), each scored against the configured rooms. Sorted by best score
 * descending. Mirrors `skill_assign.get_unassigned_skills`.
 */
export function getOrphanSkills(env: Environment): OrphanSuggestion[] {
  const all = getAllSkillNames(env);
  // computeAssignments applies the default-room fallback; recover the true
  // orphans by checking explicit + categorized assignment only.
  const { unassigned } = computeAssignments(env);
  const orphanSet = new Set(unassigned);
  const signals = deriveRoomSignals(env.config);

  const out: OrphanSuggestion[] = [];
  for (const name of all) {
    if (!orphanSet.has(name)) continue;
    const dir = findSkillDir(env, name) ?? "";
    const description = (dir && getSkillDescription(dir)) || "(no description)";
    out.push({ name, description, scores: scoreSkillForRooms(name, description, signals) });
  }
  out.sort((a, b) => (b.scores[0]?.score ?? 0) - (a.scores[0]?.score ?? 0));
  return out;
}

// ── assignment ─────────────────────────────────────────────────────────────--

/**
 * Route orphan skills to rooms.
 *
 *  - `report` (default): score and return suggestions; write nothing.
 *  - `auto`: assign each orphan to its best-scoring room, or the default room
 *    when nothing matched.
 *  - `room`: assign every orphan to `options.room` (must exist in config).
 *
 * After a writing run the config is mutated via `smol-toml` (never string
 * surgery) and room indexes can be regenerated by the caller. Returns the
 * skill→room map applied this run.
 */
export function assignOrphans(
  env: Environment,
  mode: AssignMode = "report",
  options: AssignOptions = {},
): AssignResult {
  const orphans = getOrphanSkills(env);
  const assigned: Record<string, string> = {};

  if (mode === "report") {
    return { mode, assigned, orphans };
  }

  if (mode === "room") {
    const room = options.room;
    if (!room) throw new Error("mode 'room' requires options.room");
    if (!(room in env.config.roomSkills)) throw new Error(`room '${room}' not found in config`);
    for (const o of orphans) assigned[o.name] = room;
  } else {
    // auto
    const defaultRoom = env.config.skillDefaultRoom;
    for (const o of orphans) {
      assigned[o.name] = o.scores[0]?.room ?? defaultRoom;
    }
  }

  const write = options.write ?? true;
  if (write) {
    for (const [skill, room] of Object.entries(assigned)) {
      // Skip rooms not present in config (e.g. default_room that is not a
      // configured room) — addSkillToRoom would throw; the skill simply stays
      // an orphan, which the report surfaces.
      if (room in env.config.roomSkills) {
        addSkillToRoom(env, skill, room);
      }
    }
  }

  return { mode, assigned, orphans };
}

/** Convenience: assign then return a freshly-reloaded environment for indexing. */
export function assignOrphansAndReload(
  env: Environment,
  mode: AssignMode,
  options: AssignOptions = {},
): { result: AssignResult; env: Environment } {
  const result = assignOrphans(env, mode, options);
  return { result, env: reloadEnv(env) };
}
