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

/** Max length of a one-line description before truncation (prototype: 100). */
const DESC_MAX = 100;

// ── Types ──────────────────────────────────────────────────────────────────--

export interface SkillRecord {
  /** Skill slug (directory name). */
  name: string;
  /** One-line description from SKILL.md frontmatter, or "" if none. */
  description: string;
  /** Room this skill is assigned to (default room if otherwise unassigned). */
  room: string;
  /** Absolute path to the skill directory. */
  dir: string;
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
    names.add(name);
    if (isRealDir(entry)) {
      for (const sub of safeReaddir(entry)) {
        if (existsSync(join(entry, sub, "SKILL.md"))) names.add(sub);
      }
    }
  }
  return [...names].sort();
}

/** Locate a skill's directory across the flat and nested layouts, or null. */
export function findSkillDir(env: Environment, name: string): string | null {
  const pool = env.skillsDir;
  const flat = join(pool, name);
  if (existsSync(flat)) return flat;
  if (existsSync(pool)) {
    for (const cat of safeReaddir(pool)) {
      const catDir = join(pool, cat);
      if (!isRealDir(catDir)) continue;
      const nested = join(catDir, name);
      if (existsSync(nested)) return nested;
    }
  }
  return null;
}

// ── Room assignment ────────────────────────────────────────────────────────--

/** Reverse mapping skill → room from `config.skills.rooms[*].skills`. */
export function assignRooms(config: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [room, data] of Object.entries(config.roomSkills)) {
    for (const skill of data.skills ?? []) out[skill] = room;
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
 * configured default room. Returns the mapping and the list that fell to default.
 */
export function computeAssignments(env: Environment): {
  assignments: Record<string, string>;
  unassigned: string[];
} {
  const all = getAllSkillNames(env);
  const assignments = assignRooms(env.config);
  const categorized = assignCategorizedSkills(env);
  for (const [skill, room] of Object.entries(categorized)) {
    if (!(skill in assignments)) assignments[skill] = room;
  }
  const unassigned = all.filter((s) => !(s in assignments));
  const defaultRoom = env.config.skillDefaultRoom;
  for (const skill of unassigned) assignments[skill] = defaultRoom;
  return { assignments, unassigned };
}

// ── Listing + loading ──────────────────────────────────────────────────────--

/**
 * List skills in the pool with their resolved room and description. With `room`,
 * only skills assigned to that room are returned. Sorted by name.
 */
export function listSkills(env: Environment, room?: string): SkillRecord[] {
  const { assignments } = computeAssignments(env);
  const out: SkillRecord[] = [];
  for (const name of getAllSkillNames(env)) {
    const assigned = assignments[name] ?? env.config.skillDefaultRoom;
    if (room && assigned !== room) continue;
    const dir = findSkillDir(env, name) ?? join(env.skillsDir, name);
    out.push({ name, description: getSkillDescription(dir), room: assigned, dir });
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
  const { assignments } = computeAssignments(env);
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
    room: assignments[name] ?? env.config.skillDefaultRoom,
    dir,
    skillMd: hasMd ? skillMd : null,
    content,
  };
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

/** Render one room's `skills_index.md` text (progressive-disclosure layout). */
export function renderRoomIndex(
  env: Environment,
  room: string,
  description: string,
  skillsInRoom: string[],
): string {
  const poolTemplate = env.config.skillsDirTemplate.replace(/\/$/, "");
  const lines: string[] = [
    `# ${titleizeRoom(room)} Skills Index`,
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
    "| Skill | Description |",
    "|-------|-------------|",
  ];
  for (const name of [...skillsInRoom].sort()) {
    const desc = getSkillDescription(findSkillDir(env, name) ?? join(env.skillsDir, name));
    lines.push(`| ${name} | ${desc || "(see SKILL.md for details)"} |`);
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
