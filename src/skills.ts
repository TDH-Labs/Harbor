/**
 * skills.ts — Skill pool organization + room index generation.
 *
 * Crawls the shared skill pool (`paths.skills_dir`, default `~/.agents/skills`),
 * resolves each skill to a room, and generates per-room `skills_index.md` files
 * using progressive disclosure (Map → Room → Detail). The room/skill mapping
 * comes from config (`skills.rooms`, `skills.skill_category_to_room`); paths come
 * from the {@link Environment}.
 *
 * Behavioral reference: the Python prototype's `skills_organize.py`. Two
 * de-personalizations applied (see BUILD_BRIEF §3):
 *   1. The prototype's categorized-symlink strategy hardcoded one host-specific
 *      external skills root as the symlink-target prefix. Here the category is
 *      recovered from whichever `skill_pool.sources[].source` the symlink
 *      resolves under — works for any configured source, names no machine.
 *   2. The prototype hardcoded extra "devops"/"research" index blocks even when
 *      those rooms were absent from config. Here indexes are generated for the
 *      configured rooms only; the room set is entirely config-driven.
 *
 * Downstream contract (Phase 5): `listSkills`, `getSkill`, `getSkillDescription`,
 * `generateRoomIndexes` have stable signatures the MCP server consumes.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import type { Config } from "./config.ts";
import { Environment } from "./env.ts";
import { isPathWithin } from "./path-safety.ts";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  requestRouteSkills,
  resolveRouteSkillsEndpoint,
} from "./system-one.ts";

/** Max length of a one-line description before truncation (prototype: 100). */
const DESC_MAX = 100;

// ── Types ──────────────────────────────────────────────────────────────────--

export interface SkillRecord {
  /** Skill slug (directory name). */
  name: string;
  /** One-line description from SKILL.md frontmatter, or "" if none. */
  description: string;
  /**
   * Primary room this skill displays under (default room if otherwise
   * unassigned). A skill may be GRANTED in more than one room (config can list
   * the same skill under several `[skills.rooms.*]` sections — the actual
   * access check, `roomSkillAllowed`, reads each room's own list directly and
   * is unaffected by this field). `room` picks one for single-room display
   * contexts; see {@link SkillRecord.rooms} for the complete, accurate list.
   */
  room: string;
  /** EVERY room this skill is explicitly listed under in config (may be more than one). */
  rooms: string[];
  /** Absolute path to the skill directory. */
  dir: string;
  /** Optional recommended tools from frontmatter. */
  recommendedTools?: string[];
}

export interface SkillDetail extends SkillRecord {
  /** Absolute path to the skill's SKILL.md, or null if absent. */
  skillMd: string | null;
  /** Full SKILL.md content, or "" if absent. */
  content: string;
}

export interface RoomIndexResult {
  /** Room → absolute path of the written `skills_index.md` (rooms with skills). */
  written: Record<string, string>;
  /** Skill names that matched no room and fell to the default room. */
  unassigned: string[];
  /** Final skill → room mapping after defaults are applied. */
  assignments: Record<string, string>;
}

export interface SkillSearchResult extends SkillRecord {
  /** Relevance score for ranking. */
  score: number;
}

// ── Description parsing ───────────────────────────────────────────────────────

/**
 * Extract the one-line `description:` from a SKILL.md's YAML frontmatter.
 *
 * `path` may be a SKILL.md file or a directory containing one. Handles plain
 * scalars (optionally quoted) and YAML block scalars (`|` / `>`), where the
 * description spans subsequent indented lines joined with single spaces. The
 * result is truncated to {@link DESC_MAX} chars (97 + "…"). Returns "" when the
 * file or a description is absent. Mirrors `skills_organize.get_skill_description`.
 */
export function getSkillDescription(path: string): string {
  let mdPath = path;
  try {
    if (statSync(path).isDirectory()) mdPath = join(path, "SKILL.md");
  } catch {
    return "";
  }
  if (!existsSync(mdPath)) return "";

  let text: string;
  try {
    text = readFileSync(mdPath, "utf8");
  } catch {
    return "";
  }

  const lines = text.split("\n");
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.trim();
    if (stripped === "---") {
      if (inFrontmatter) break; // end of frontmatter
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && stripped.startsWith("description:")) {
      let val = stripped.slice("description:".length).trim();
      // strip a single layer of surrounding quotes
      val = stripQuotes(val);
      let desc: string;
      if (val.startsWith("|") || val.startsWith(">")) {
        // YAML block scalar: collect subsequent indented (non-blank) lines.
        const parts: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j]!;
          // A line that starts at column 0 (no leading whitespace) ends the block.
          if (next.length > 0 && !/^\s/.test(next)) break;
          const content = next.trim();
          if (content) parts.push(content);
        }
        desc = parts.join(" ");
      } else {
        desc = val;
      }
      if (desc.length > DESC_MAX) desc = desc.slice(0, DESC_MAX - 3) + "...";
      return desc;
    }
  }
  return "";
}

/**
 * Extract `recommended_tools:`, `allowed_tools:`, or `tools:` from a SKILL.md's YAML frontmatter.
 * Handles YAML lists (- item), flow arrays [a, b], or comma-separated strings.
 * Returns an array of trimmed tool name strings. Returns [] if none or on parse error.
 */
export function getSkillRecommendedTools(path: string): string[] {
  let mdPath = path;
  try {
    if (statSync(path).isDirectory()) mdPath = join(path, "SKILL.md");
  } catch {
    return [];
  }
  if (!existsSync(mdPath)) return [];

  let text: string;
  try {
    text = readFileSync(mdPath, "utf8");
  } catch {
    return [];
  }

  const lines = text.split("\n");
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.trim();
    if (stripped === "---") {
      if (inFrontmatter) break; // end of frontmatter
      inFrontmatter = true;
      continue;
    }
    if (
      inFrontmatter &&
      (stripped.startsWith("recommended_tools:") ||
        stripped.startsWith("allowed_tools:") ||
        stripped.startsWith("allowed-tools:") ||
        stripped.startsWith("tools:"))
    ) {
      const colonIdx = stripped.indexOf(":");
      let val = stripped.slice(colonIdx + 1).trim();
      val = stripQuotes(val);

      // Case 1: Flow array, e.g. [toolA, toolB]
      if (val.startsWith("[") && val.endsWith("]")) {
        return val
          .slice(1, -1)
          .split(",")
          .map((t) => stripQuotes(t.trim()))
          .filter(Boolean);
      }

      // Case 2: Inline comma-separated list, e.g. toolA, toolB
      if (val.length > 0 && !val.startsWith("|") && !val.startsWith(">") && !val.startsWith("-")) {
        return val
          .split(",")
          .map((t) => stripQuotes(t.trim()))
          .filter(Boolean);
      }

      // Case 3: Block list (- item) on subsequent indented lines
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.length > 0 && !/^\s/.test(next)) break; // unindented line terminates block
        const itemLine = next.trim();
        if (itemLine.startsWith("-")) {
          const itemVal = stripQuotes(itemLine.slice(1).trim());
          if (itemVal) items.push(itemVal);
        }
      }
      return items;
    }
  }
  return [];
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ── Pool discovery ─────────────────────────────────────────────────────────--

/**
 * All skill slugs in the pool, flat and one-level-nested (categorized), sorted.
 * A flat entry is any directory or symlink directly under the pool; a nested
 * entry is a `<category>/<skill>/SKILL.md`. Mirrors `get_all_skill_names`.
 */
export function getAllSkillNames(env: Environment): string[] {
  const pool = env.skillsDir;
  const names = new Set<string>();
  if (!existsSync(pool)) return [];
  for (const name of safeReaddir(pool)) {
    const entry = join(pool, name);
    if (!isDirOrSymlink(entry)) continue;
    // A top-level entry counts as a skill only if it IS one — i.e. it has its
    // own SKILL.md (existsSync follows symlinks, so a flat symlink-to-skill
    // counts and a broken/dangling symlink does not). A real directory WITHOUT
    // its own SKILL.md is a category container (e.g. `mattpocock-eng/` holding
    // symlinks to room-local skills), not a skill — skip it as a name but still
    // surface the nested skills it groups. Without this guard, category dirs
    // were counted as phantom skills and dumped into the default room.
    if (existsSync(join(entry, "SKILL.md"))) names.add(name);
    if (isRealDir(entry)) {
      for (const sub of safeReaddir(entry)) {
        if (existsSync(join(entry, sub, "SKILL.md"))) names.add(sub);
      }
    }
  }
  return [...names].sort();
}

/**
 * Locate a skill's directory across the flat and nested layouts, or null.
 *
 * `name` is caller/agent-supplied and must never be trusted to stay inside the
 * pool: `join(pool, name)` normalizes `..` segments but happily walks the
 * result outside `pool` (e.g. `name = "../../rooms/legal-private/secret-skill"`
 * previously resolved and returned a directory well outside the shared skill
 * pool — an arbitrary-directory read). Every candidate is resolved and checked
 * against its intended parent before being accepted.
 */
export function findSkillDir(env: Environment, name: string): string | null {
  const pool = env.skillsDir;
  const flat = join(pool, name);
  if (isPathWithin(flat, pool) && existsSync(flat)) return flat;
  if (existsSync(pool)) {
    for (const cat of safeReaddir(pool)) {
      const catDir = join(pool, cat);
      if (!isRealDir(catDir)) continue;
      const nested = join(catDir, name);
      if (isPathWithin(nested, catDir) && existsSync(nested)) return nested;
    }
  }
  return null;
}

// ── Room assignment ────────────────────────────────────────────────────────--

/**
 * Reverse mapping skill → room from `config.skills.rooms[*].skills`. A skill
 * explicitly listed under more than one room's `skills` array resolves to
 * whichever room is LAST in {@link explicitSkillRooms}'s per-skill array — a
 * single "primary" pick for display contexts that need exactly one room.
 * Derived from {@link explicitSkillRooms} via {@link lastRoomWins} rather
 * than an independent walk of `config.roomSkills`, so the "primary" pick
 * here and the full list there can never disagree about which room a
 * multi-room skill's primary is — they're computed from the same array, not
 * two passes that merely happen to agree on iteration order. Use
 * {@link explicitSkillRooms} for the complete, order-independent set of every
 * room a skill is actually granted in.
 */
export function assignRooms(config: Config): Record<string, string> {
  return lastRoomWins(explicitSkillRooms(config));
}

/** `assignRooms`/`computeAssignments`'s shared "last-listed room wins" rule. */
function lastRoomWins(explicit: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [skill, rooms] of Object.entries(explicit)) out[skill] = rooms[rooms.length - 1]!;
  return out;
}

/**
 * Every room each skill is explicitly listed under in config — the complete,
 * order-independent picture `assignRooms`'s single-room map can't represent. A
 * skill intentionally shared across rooms (e.g. `security-gate` in both
 * `devops` and `legal`) appears in both entries here; `roomSkillAllowed`
 * (isolation.ts) already grants access per-room directly from config and is
 * unaffected either way — this is purely for accurate display/listing.
 */
export function explicitSkillRooms(config: Config): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [room, data] of Object.entries(config.roomSkills)) {
    for (const skill of data.skills ?? []) {
      (out[skill] ??= []).push(room);
    }
  }
  return out;
}

/**
 * Map categorized-pool skills to rooms via `skills.skill_category_to_room`.
 *
 * Strategy 1 — categorized layout: `<pool>/<category>/<skill>/SKILL.md`. The
 * category directory name is looked up in the category→room map (default room on
 * miss).
 *
 * Strategy 2 — flat symlink layout: `<pool>/<skill>` is a symlink whose target
 * lives under one of the configured `skill_pool.sources[].source` roots; the
 * first path segment under that root is the category. This is the de-personalized
 * analogue of the prototype's single hardcoded external-skills-root prefix.
 */
export function assignCategorizedSkills(env: Environment): Record<string, string> {
  const out: Record<string, string> = {};
  const pool = env.skillsDir;
  const categoryToRoom = env.config.skillCategoryToRoom;
  const defaultRoom = env.config.skillDefaultRoom;
  if (!existsSync(pool)) return out;

  // Strategy 1: category directories containing skill subdirs.
  for (const cat of safeReaddir(pool)) {
    const catDir = join(pool, cat);
    if (!isRealDir(catDir)) continue;
    const hasSkills = safeReaddir(catDir).some(
      (d) => existsSync(join(catDir, d, "SKILL.md")),
    );
    if (!hasSkills) continue;
    const room = categoryToRoom[cat] ?? defaultRoom;
    for (const skill of safeReaddir(catDir)) {
      if (existsSync(join(catDir, skill, "SKILL.md"))) out[skill] = room;
    }
  }

  // Strategy 2: resolve symlinks to a configured source root → category.
  const sourceRoots = env.config.skillPoolSources
    .map((s) => env.resolve(s.source))
    .map((p) => (p.endsWith("/") ? p : p + "/"));
  for (const name of safeReaddir(pool).sort()) {
    if (name in out) continue;
    const entry = join(pool, name);
    if (!isDirOrSymlink(entry)) continue;
    if (!existsSync(join(entry, "SKILL.md"))) continue;
    if (!isSymlink(entry)) continue;
    let target: string;
    try {
      target = readlinkSync(entry);
    } catch {
      continue;
    }
    const absTarget = isAbsolute(target) ? target : resolvePath(pool, target);
    for (const root of sourceRoots) {
      if (absTarget.startsWith(root)) {
        const rel = absTarget.slice(root.length);
        const cat = rel.split("/")[0] ?? "";
        out[name] = categoryToRoom[cat] ?? defaultRoom;
        break;
      }
    }
  }

  return out;
}

/**
 * Compute the final skill → room mapping: explicit room lists first, then
 * categorized/symlink assignments, then everything still unassigned falls to the
 * configured default room. Returns the mapping, the list that fell to default,
 * and the complete explicit-rooms picture ({@link explicitSkillRooms}) computed
 * once here and returned rather than left for callers (listSkills/getSkill) to
 * re-derive with a second walk of `config.roomSkills`.
 */
export function computeAssignments(env: Environment): {
  assignments: Record<string, string>;
  unassigned: string[];
  explicitRooms: Record<string, string[]>;
} {
  const all = getAllSkillNames(env);
  const explicitRooms = explicitSkillRooms(env.config);
  const assignments = lastRoomWins(explicitRooms);
  const categorized = assignCategorizedSkills(env);
  for (const [skill, room] of Object.entries(categorized)) {
    if (!(skill in assignments)) assignments[skill] = room;
  }
  const unassigned = all.filter((s) => !(s in assignments));
  const defaultRoom = env.config.skillDefaultRoom;
  for (const skill of unassigned) assignments[skill] = defaultRoom;
  return { assignments, unassigned, explicitRooms };
}

// ── Listing + loading ──────────────────────────────────────────────────────--

/**
 * List skills in the pool with their resolved room and description. With `room`,
 * only skills assigned to that room are returned. Sorted by name.
 */
export function listSkills(env: Environment, room?: string): SkillRecord[] {
  const { assignments, explicitRooms } = computeAssignments(env);
  const out: SkillRecord[] = [];
  for (const name of getAllSkillNames(env)) {
    const assigned = assignments[name] ?? env.config.skillDefaultRoom;
    // A skill explicitly listed under several rooms must be visible from ANY
    // of them, not just assignRooms()'s single "primary" pick — otherwise a
    // skill genuinely shared across rooms (e.g. security-gate in both devops
    // and legal) would be invisible to list_skills from one of them even
    // though read_skill (roomSkillAllowed, isolation.ts) already grants it.
    const rooms = explicitRooms[name] ?? [assigned];
    // `undefined` means "no filter" (the CLI's `skills-list` with no --room).
    // An EMPTY STRING is a room that simply matches nothing — not a wildcard.
    // Treating "" as falsy here meant a session whose room resolved to "" (a
    // client substituting an unset variable with an empty string) enumerated
    // the entire pool across every room. Defense in depth: the env-read sites
    // now normalize blank to the default room, but this filter must not be a
    // wildcard on its own either.
    if (room !== undefined && !rooms.includes(room)) continue;
    const dir = findSkillDir(env, name) ?? join(env.skillsDir, name);
    out.push({ name, description: getSkillDescription(dir), room: assigned, rooms, dir });
  }
  return out;
}

/**
 * Load a single skill's full detail (description + raw SKILL.md content), or
 * null when the skill is not found in the pool. Phase 5's MCP server uses this
 * to serve skill content.
 */
export function getSkill(env: Environment, name: string): SkillDetail | null {
  const dir = findSkillDir(env, name);
  if (!dir) return null;
  const { assignments, explicitRooms } = computeAssignments(env);
  const assigned = assignments[name] ?? env.config.skillDefaultRoom;
  const rooms = explicitRooms[name] ?? [assigned];
  const skillMd = join(dir, "SKILL.md");
  const hasMd = existsSync(skillMd);
  let content = "";
  if (hasMd) {
    try {
      content = readFileSync(skillMd, "utf8");
    } catch {
      content = "";
    }
  }
  return {
    name,
    description: getSkillDescription(dir),
    room: assigned,
    rooms,
    dir,
    skillMd: hasMd ? skillMd : null,
    content,
    recommendedTools: getSkillRecommendedTools(dir),
  };
}

/** Longest search query considered (characters) and most distinct terms scored. */
export const MAX_SEARCH_QUERY_CHARS = 512;
export const MAX_SEARCH_TERMS = 32;

/**
 * Search skills in the pool by query string. Returns matching skills sorted by
 * relevance, capped at `limit` (default 5, max 50). With `room`, only skills
 * accessible to that room are searched.
 */
export function searchSkills(
  env: Environment,
  query: string,
  room?: string,
  limit: number = 5,
): SkillSearchResult[] {
  // Bounded: matching is O(skills × terms) substring scans, and the query comes
  // from an agent (or, on a server, a tenant). An unbounded one is a CPU-denial
  // request against a single-threaded process.
  const q = query.trim().toLowerCase().slice(0, MAX_SEARCH_QUERY_CHARS);
  if (!q) return [];
  const maxResults = Math.max(1, Math.min(50, limit));
  const skills = listSkills(env, room);
  const terms = [...new Set(q.split(/[\s,._\-+/]+/).filter(Boolean))].slice(0, MAX_SEARCH_TERMS);

  const scored: SkillSearchResult[] = [];
  for (const s of skills) {
    const nameLower = s.name.toLowerCase();
    const descLower = s.description.toLowerCase();
    let score = 0;

    // Exact skill name match
    if (nameLower === q) {
      score += 100;
    } else if (nameLower.includes(q)) {
      score += 50;
    }

    // Phrase match in description
    if (descLower.includes(q)) {
      score += 30;
    }

    // Term-by-term matching
    for (const t of terms) {
      if (t.length === 0) continue;
      if (nameLower === t) {
        score += 25;
      } else if (nameLower.includes(t)) {
        score += 15;
      }
      if (descLower.includes(t)) {
        score += 10;
      }
    }

    if (score > 0) {
      scored.push({ ...s, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, maxResults);
}

// ── Index generation ───────────────────────────────────────────────────────--

/** Title-case a room slug for display (`incident_response` → `Incident Response`). */
function titleizeRoom(room: string): string {
  return room
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Strip an optional "room/" prefix from a sub-domain hint, returning the bare
 * label. "legal/litigation" → "litigation"; "litigation" → "litigation".
 */
function subdomainLabel(hint: string): string {
  const slash = hint.indexOf("/");
  return (slash >= 0 ? hint.slice(slash + 1) : hint).trim();
}

/**
 * Render one room's `skills_index.md` text (progressive-disclosure layout).
 * When per-skill sub-domain hints are configured (`[skills.skill_subdomain]`),
 * skills are grouped under `##` sub-sections sorted alphabetically ("other"
 * last); with no hints configured, all skills render in a single flat table.
 * This is the single source of truth for room index content — both `harbor
 * sync` (via `generateRoomIndex` in sync.ts) and every skill-mutation command
 * (`skill-install`, `skill-create`, `skill-room-add`, `skills-list`, via
 * `generateRoomIndexes` below) render through this function, so the file
 * never flips between two incompatible formats depending on which ran last.
 */
export function renderRoomIndex(
  env: Environment,
  room: string,
  description: string,
  skillsInRoom: string[],
): string {
  const title = `${titleizeRoom(room)} Skills Index`;
  if (skillsInRoom.length === 0) {
    return [`# ${title}`, "", "_No skills configured for this room._", ""].join("\n");
  }

  const poolTemplate = env.config.skillsDirTemplate.replace(/\/$/, "");
  const lines: string[] = [
    `# ${title}`,
    "",
    `> ${description}`,
    `> Skills in this room: ${skillsInRoom.length}`,
    `> Storage: \`${poolTemplate}/<name>/SKILL.md\` (shared pool)`,
    "> Load only the skill you need — do NOT load all skills at once.",
    "",
    "## How to Use Skills in This Room",
    "",
    "1. **Scan** the table below for a skill that matches your task",
    `2. **Read** only that skill's SKILL.md: \`cat ${poolTemplate}/<name>/SKILL.md\``,
    "3. **Follow** the skill's instructions — it will tell you exactly what to do",
    "",
  ];

  const tableRows = (names: string[]): string[] =>
    [...names].sort().map((name) => {
      const desc = getSkillDescription(findSkillDir(env, name) ?? join(env.skillsDir, name));
      return `| ${name} | ${desc || "(see SKILL.md for details)"} |`;
    });

  const hints = env.config.skillSubdomains;
  const grouped: Record<string, string[]> = {};
  for (const s of skillsInRoom) {
    const hint = hints[s];
    const group = hint ? subdomainLabel(hint) || "other" : "other";
    (grouped[group] ??= []).push(s);
  }
  const groups = Object.keys(grouped);

  if (groups.length === 1 && groups[0] === "other") {
    // No sub-domain hints configured — single flat table (back-compat).
    lines.push("| Skill | Description |", "|-------|-------------|", ...tableRows(skillsInRoom));
  } else {
    // "other" sorts last; the rest alphabetically.
    const ordered = groups.sort((a, b) =>
      a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b),
    );
    for (const g of ordered) {
      lines.push(
        `## ${g}`,
        "",
        "| Skill | Description |",
        "|-------|-------------|",
        ...tableRows(grouped[g] as string[]),
        "",
      );
    }
  }

  lines.push(
    "",
    "## Adding Skills to This Room",
    "",
    "Add the skill slug to this room's `skills` list in your Harbor config",
    "(`[skills.rooms.<room>]`), then run `harbor skills-list` to regenerate indexes.",
    "",
  );
  return lines.join("\n");
}

/**
 * Generate `skills_index.md` for every configured room from the pool + config.
 * Rooms with no skills are skipped. Returns the written paths, the default-room
 * fallbacks, and the final assignment map. Mirrors `generate_room_indexes`
 * (minus the prototype's hardcoded devops/research blocks — see module header).
 */
export function generateRoomIndexes(env: Environment): RoomIndexResult {
  const { assignments, unassigned } = computeAssignments(env);

  const roomToSkills: Record<string, string[]> = {};
  for (const [skill, room] of Object.entries(assignments)) {
    (roomToSkills[room] ??= []).push(skill);
  }

  const written: Record<string, string> = {};
  for (const [room, data] of Object.entries(env.config.roomSkills)) {
    const skillsInRoom = roomToSkills[room] ?? [];
    if (skillsInRoom.length === 0) continue;
    const content = renderRoomIndex(env, room, data.description ?? "", skillsInRoom);
    const roomDir = join(env.rooms, room);
    mkdirSync(roomDir, { recursive: true });
    const indexPath = join(roomDir, "skills_index.md");
    writeFileSync(indexPath, content);
    written[room] = indexPath;
  }

  return { written, unassigned, assignments };
}

/**
 * Render the master skills overview (Map tier) for `agent_map.md`: one row per
 * room with its focus and skill count. Mirrors `generate_master_index`.
 */
export function generateMasterIndex(env: Environment): string {
  const { assignments } = computeAssignments(env);
  const rooms = env.config.roomSkills;
  const lines: string[] = [
    "## Skills — Progressive Disclosure",
    "",
    "Do NOT scan all skills. Navigate: Map → Room → Detail.",
    "",
    "| Room | Focus | Skills |",
    "|------|-------|--------|",
  ];
  for (const room of Object.keys(rooms).sort()) {
    const focus = (rooms[room]?.description ?? "").split(",")[0];
    const count = Object.values(assignments).filter((r) => r === room).length;
    lines.push(`| ${room} | ${focus} | ${count} |`);
  }
  const total = getAllSkillNames(env).length;
  lines.push(
    "",
    `Total: ${total} skills across ${Object.keys(rooms).length} rooms.`,
    "Room indexes: `<root>/rooms/<room>/skills_index.md`",
    "",
  );
  return lines.join("\n");
}

// ── filesystem helpers ─────────────────────────────────────────────────────--

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
/** True for a directory or a symlink (the entry exists and is one of those). */
function isDirOrSymlink(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() || st.isSymbolicLink();
  } catch {
    return false;
  }
}
/** True only for a real directory (follows symlinks; a symlink-to-dir is false here). */
function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── Dynamic Turn-Sieve ───────────────────────────────────────────────────────

/** Skills a turn may load by default. */
export const TURN_SIEVE_DEFAULT_MAX = 3;
/**
 * Ceiling when System One flags the turn `crossDomain`. The flag comes from the
 * classifier's answer, never from the prompt, and the deterministic fallback
 * never escalates — a prompt cannot talk its way into a bigger context budget.
 */
export const TURN_SIEVE_ESCALATED_MAX = 5;
/** Most distinct prompt tokens the keyword matcher scores (see matchSkillsDeterministically). */
export const MAX_MATCH_TOKENS = 256;
/**
 * A deterministic match scoring under this is noise (a single stray description
 * word scores 10). Requiring 20 means two description hits or one name token.
 */
export const MIN_DETERMINISTIC_SCORE = 20;

export interface TurnSieveResult {
  selectedSkills: string[];
  selectedTools: string[];
  promptTokenSavingsPct: number;
  /** Who produced the selection. */
  source: "system-one" | "deterministic";
  /** System One flagged the turn as spanning domains (selection may exceed the base cap). */
  crossDomain: boolean;
  /**
   * Skill names System One returned that are NOT in the room's available skills
   * and were discarded. For server-side audit only — do not show to the agent
   * (the names belong to other rooms).
   */
  dropped: string[];
  /** Why the deterministic fallback ran instead of System One, when it did. */
  fallbackReason?: string;
}

export interface RouteSkillsOptions {
  /** Full route-skills URL (or base URL). See system-one.ts for precedence. */
  endpoint?: string;
  timeoutMs?: number;
  /** Base URL from config (`[system_one] url`). */
  configUrl?: string;
  reservedPorts?: readonly number[];
  /** Base cap (default {@link TURN_SIEVE_DEFAULT_MAX}, clamped to 1..5). */
  maxSkills?: number;
  /** Cross-domain cap (default {@link TURN_SIEVE_ESCALATED_MAX}, clamped to base..5). */
  escalatedMaxSkills?: number;
}

/** Clamp the configured caps into a sane, ordered pair (base ≤ escalated ≤ 5). */
export function sieveLimits(maxSkills?: number, escalatedMaxSkills?: number): { base: number; escalated: number } {
  const int = (v: number | undefined, dflt: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt;
  const base = Math.min(TURN_SIEVE_ESCALATED_MAX, Math.max(1, int(maxSkills, TURN_SIEVE_DEFAULT_MAX)));
  const escalated = Math.min(
    TURN_SIEVE_ESCALATED_MAX,
    Math.max(base, int(escalatedMaxSkills, TURN_SIEVE_ESCALATED_MAX)),
  );
  return { base, escalated };
}

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "all", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "could", "did", "do", "does", "doing", "down", "during", "each",
  "few", "for", "from", "further", "had", "has", "have", "having", "he", "her", "here",
  "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it",
  "its", "itself", "just", "me", "more", "most", "my", "myself", "no", "nor", "not",
  "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves",
  "out", "over", "own", "s", "same", "she", "should", "so", "some", "such", "than",
  "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "will", "with", "would", "you", "your", "yours", "yourself", "yourselves",
]);

function calculateSavingsPct(availableCount: number, selectedCount: number): number {
  if (availableCount === 0) return 0;
  if (selectedCount >= availableCount) return 0;
  return Math.max(0, Math.min(100, Math.round(((availableCount - selectedCount) / availableCount) * 100)));
}

/** Union of `recommendedTools` across `skills`, in first-seen order. */
function toolsOf(skills: Iterable<SkillRecord>): string[] {
  const out = new Set<string>();
  for (const s of skills) for (const t of s.recommendedTools ?? []) out.add(t);
  return [...out];
}

/**
 * Deterministically match available skills against the turn prompt using keyword
 * heuristics, returning at most `maxSkills` (default {@link TURN_SIEVE_DEFAULT_MAX};
 * pass `Infinity` for every match). Weak matches (< {@link MIN_DETERMINISTIC_SCORE})
 * are dropped. Never escalates: only System One can flag a turn cross-domain.
 */
export function matchSkillsDeterministically(
  turnPrompt: string,
  room: string,
  availableSkills: SkillRecord[],
  maxSkills: number = TURN_SIEVE_DEFAULT_MAX,
): TurnSieveResult {
  const base = { source: "deterministic" as const, crossDomain: false, dropped: [] as string[] };
  if (availableSkills.length === 0) {
    return { selectedSkills: [], selectedTools: [], promptTokenSavingsPct: 0, ...base };
  }

  // Bounded like searchSkills: this loop is O(skills × tokens) substring scans.
  // Measured before the bound: a 1 MiB prompt of distinct words against 400
  // skills held the thread for ~5 s (~23 ms after) — one request stalling every
  // other tenant on a single-threaded server.
  const promptLower = turnPrompt.slice(0, MAX_PROMPT_CHARS).toLowerCase().trim();
  if (!promptLower) {
    return { selectedSkills: [], selectedTools: [], promptTokenSavingsPct: 100, ...base };
  }

  const rawTokens = promptLower.split(/[^a-zA-Z0-9_\-]+/).filter(Boolean);
  const meaningfulTokens = [
    ...new Set(rawTokens.filter((t) => t.length >= 2 && !STOP_WORDS.has(t))),
  ].slice(0, MAX_MATCH_TOKENS);

  const scored: Array<{ skill: SkillRecord; score: number }> = [];

  for (const skill of availableSkills) {
    const nameLower = skill.name.toLowerCase();
    const descLower = (skill.description || "").toLowerCase();
    const nameTokens = nameLower.split(/[-_]+/).filter(Boolean);
    let score = 0;

    // Exact skill name in prompt
    if (promptLower.includes(nameLower)) {
      score += 100;
    }

    // Name tokens phrase match (e.g. "audit xls" for "audit-xls")
    const namePhrase = nameTokens.join(" ");
    if (namePhrase && promptLower.includes(namePhrase)) {
      score += 80;
    }

    // Individual name tokens match
    let matchedNameTokens = 0;
    for (const token of nameTokens) {
      if (rawTokens.includes(token)) {
        score += 30;
        matchedNameTokens++;
      } else if (token.length >= 3 && promptLower.includes(token)) {
        score += 15;
        matchedNameTokens++;
      }
    }
    if (nameTokens.length > 1 && matchedNameTokens === nameTokens.length) {
      score += 40;
    }

    // Description matching with meaningful prompt tokens
    for (const token of meaningfulTokens) {
      if (descLower.includes(token)) {
        score += 10;
      }
    }

    // Recommended tools match
    if (skill.recommendedTools) {
      for (const tool of skill.recommendedTools) {
        if (promptLower.includes(tool.toLowerCase())) {
          score += 15;
        }
      }
    }

    if (score >= MIN_DETERMINISTIC_SCORE) {
      scored.push({ skill, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  const cap = Number.isFinite(maxSkills) ? Math.max(0, Math.trunc(maxSkills)) : scored.length;
  const picked = scored.slice(0, cap).map((s) => s.skill);
  const selectedSkills = picked.map((s) => s.name);

  return {
    selectedSkills,
    selectedTools: toolsOf(picked),
    promptTokenSavingsPct: calculateSavingsPct(availableSkills.length, selectedSkills.length),
    ...base,
  };
}

/**
 * Route relevant skills and tools for an agent turn.
 *
 * `availableSkills` MUST already be limited to what the caller's room may load
 * (e.g. `listSkills(env, room)`): the router's answer is intersected with it,
 * which is what stops a wrong or hostile daemon from naming another room's
 * skills. System One is asked first (sub-50ms budget); on any failure — down,
 * slow, refused endpoint, malformed or all-foreign answer — this falls back to
 * {@link matchSkillsDeterministically}, and `fallbackReason` says why.
 *
 * Caps: {@link TURN_SIEVE_DEFAULT_MAX} skills, {@link TURN_SIEVE_ESCALATED_MAX}
 * only when System One flags the turn `crossDomain`. Tool names come from the
 * selected skills' own frontmatter; a tool the router adds is accepted only if
 * some available skill already recommends it, so the router cannot inject
 * arbitrary text into the advisory tool list.
 */
export async function routeSkillsForTurn(
  turnPrompt: string,
  room: string,
  availableSkills: SkillRecord[],
  options: RouteSkillsOptions = {},
): Promise<TurnSieveResult> {
  if (availableSkills.length === 0) {
    return {
      selectedSkills: [],
      selectedTools: [],
      promptTokenSavingsPct: 0,
      source: "deterministic",
      crossDomain: false,
      dropped: [],
    };
  }

  const limits = sieveLimits(options.maxSkills, options.escalatedMaxSkills);
  const fallback = (reason: string, dropped: string[] = []): TurnSieveResult => ({
    ...matchSkillsDeterministically(turnPrompt, room, availableSkills, limits.base),
    dropped,
    fallbackReason: reason,
  });

  const resolved = resolveRouteSkillsEndpoint({
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.configUrl ? { configUrl: options.configUrl } : {}),
    ...(options.reservedPorts ? { reservedPorts: options.reservedPorts } : {}),
  });
  if (!resolved.ok) return fallback(resolved.reason);

  const outcome = await requestRouteSkills(
    resolved.endpoint,
    {
      prompt: turnPrompt,
      room,
      availableSkills: availableSkills.map((s) => ({
        name: s.name,
        description: s.description,
        recommendedTools: s.recommendedTools,
      })),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!outcome.ok) return fallback(outcome.reason);

  const byName = new Map(availableSkills.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const name of outcome.answer.skills) {
    if (seen.has(name)) continue;
    seen.add(name);
    (byName.has(name) ? kept : dropped).push(name);
  }
  if (kept.length === 0 && dropped.length > 0) {
    return fallback("System One named only skills outside this room; answer ignored", dropped);
  }

  const limit = outcome.answer.crossDomain ? limits.escalated : limits.base;
  const selectedSkills = kept.slice(0, limit);
  const chosen = selectedSkills.map((n) => byName.get(n) as SkillRecord);

  const known = new Set(toolsOf(availableSkills));
  const selectedTools = new Set(toolsOf(chosen));
  for (const t of outcome.answer.tools) if (known.has(t)) selectedTools.add(t);

  return {
    selectedSkills,
    selectedTools: [...selectedTools],
    promptTokenSavingsPct: calculateSavingsPct(availableSkills.length, selectedSkills.length),
    source: "system-one",
    crossDomain: outcome.answer.crossDomain,
    dropped,
  };
}
