/**
 * sync.ts — Beacon generation + agent_map.md synchronization.
 *
 * Generates the home-level AI beacons (AGENTS.md, CLAUDE.md, .cursorrules),
 * per-room AGENTS.md, room skill indexes, and keeps the agent_map.md room/project
 * tables in sync with discovery + config. This is the TypeScript port of the
 * Python prototype's `beacon_sync.py` (BUILD_BRIEF §reference).
 *
 * Behavioral-fidelity notes (from `beacon_sync.py`, where SPEC_TS is silent):
 *   - The ownership stamp written at the end of every *home* beacon is the exact
 *     marker {@link SYNC_STAMP}. Its presence is how the watcher and `check`
 *     recognise a file as agent-env-owned (absent ⇒ another tool overwrote it).
 *   - `--generate-only` regenerates beacons from the *existing* agent_map.md and
 *     skips discovery / map updates / hygiene (`runGenerate` vs `fullSync`).
 *   - agent_map.md tables are detected by header substring: the room table header
 *     contains "| Room", the project table header contains "| Project" and
 *     "Path" (a "Workspace" column is accepted as a Path alias).
 *   - A workspace project dir is scaffolded with three compaction stubs
 *     (research.md / plan.md / scratchpad.md) plus an AGENTS.md *symlink* to the
 *     home beacon — never a content copy.
 *   - Writes are idempotent: a file is only rewritten when its content changes.
 *
 * De-personalization: every path in generated output is derived from
 * `env.homeStr` (which resolves via `os.homedir()` in production, a temp dir in
 * tests). No machine path or room name is hardcoded here.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Environment } from "./env.ts";
import { computeAssignments } from "./skills.ts";

/** Ownership marker appended to every home-level beacon. */
export const SYNC_STAMP = "<!-- agent-env:sync -->";

/**
 * Always-read guardrail emitted into the home AGENTS.md and CLAUDE.md: how to
 * correctly extend a Harbor environment. Because the beacon is the one surface
 * every agent reads first, putting the install rules here makes them
 * guaranteed-read — preventing the common contamination failure (npx-global
 * install / manual pool dumps / cross-agent symlinks). The full step-by-step
 * lives in the progressively-loaded `extending-harbor` skill this block points
 * at; only the damage-preventing rules are always-on. Commands are home-agnostic
 * so this is a static block.
 */
export const EXTEND_GUARDRAIL: string[] = [
  "## Extending This Environment",
  "",
  "This machine runs **Harbor**. To add skills, MCP servers, or tools, go through",
  "Harbor — never install globally or edit the skill pool by hand.",
  "",
  "- **Add a skill:** `harbor skill-install <source> --room <room>`. NEVER",
  "  `npx skills add -g`, manual copies into the pool, or symlinks into agents'",
  "  auto-load dirs — that leaks one skill into every agent and breaks routing.",
  "- **Route an existing skill to a room:** `harbor skill-assign`.",
  "- **Add an MCP server / wire an agent:** `harbor install --for <agent>`",
  "  (prints the config; add `--write` to apply it with a backup).",
  "- **After any change:** run `harbor sync` to regenerate beacons + room indexes.",
  "- Don't hand-edit `config.toml` when a command owns it; don't fight the watcher.",
  "",
  "Full procedures: read the `extending-harbor` skill first.",
];

// ── Markdown table parsing ───────────────────────────────────────────────────

export interface TableRow {
  [column: string]: string;
}

/** Split a "| a | b | c |" row into trimmed cells (outer pipes dropped). */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")) && c.includes("-"));
}

/**
 * Parse the first GitHub-flavored markdown table found in `lines` into rows
 * keyed by header cell. Returns `[]` when no table is present.
 */
export function parseTable(lines: string[]): TableRow[] {
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.trim().startsWith("|") && line.includes("|", 1)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];
  const header = splitRow(lines[headerIdx] as string);
  const rows: TableRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim().startsWith("|")) break; // table ended
    const cells = splitRow(raw);
    if (isSeparatorRow(cells)) continue;
    const row: TableRow = {};
    header.forEach((col, idx) => {
      row[col] = cells[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/** Parse agent_map.md into `## ` sections (text before the first header is "preamble"). */
export function parseAgentMap(content: string): Record<string, string[]> {
  const sections: Record<string, string[]> = { preamble: [] };
  let current = "preamble";
  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      sections[current] = [];
    } else {
      (sections[current] as string[]).push(line);
    }
  }
  return sections;
}

/** Extract the room table (header contains "| Room") from agent_map.md. */
export function parseRoomTable(content: string): TableRow[] {
  for (const lines of Object.values(parseAgentMap(content))) {
    if (lines.some((l) => l.includes("| Room"))) return parseTable(lines);
  }
  return [];
}

/** Extract the project table (header contains "| Project" and "Path") from agent_map.md. */
export function parseProjectTable(content: string): TableRow[] {
  for (const lines of Object.values(parseAgentMap(content))) {
    if (lines.some((l) => l.includes("| Project") && l.includes("Path"))) {
      return parseTable(lines);
    }
  }
  return [];
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** A directory is a "project" if it isn't hidden/skipped and carries a signature file. */
export function isProjectDir(env: Environment, path: string): boolean {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  const name = path.split("/").filter(Boolean).pop() ?? "";
  if (name.startsWith(".") || env.config.skipDirs.has(name)) return false;
  return env.config.projectSignatures.some((sig) => existsSync(join(path, sig)));
}

/** Immediate subdirs of `~/rooms/` that contain a `room_rules.md` — the room signature file. */
export function discoverRooms(env: Environment): string[] {
  if (!existsSync(env.rooms)) return [];
  const out: string[] = [];
  for (const name of readdirSync(env.rooms)) {
    const p = join(env.rooms, name);
    try {
      if (statSync(p).isDirectory() && existsSync(join(p, "room_rules.md"))) out.push(name);
    } catch {
      // skip unreadable entries
    }
  }
  return out.sort();
}

/** Normalize a Path cell to the room dir name: "`~/rooms/legal/`" → "legal". */
function roomDir(path: string): string {
  return path.replace(/`/g, "").replace(/\/$/, "").split("/").filter(Boolean).pop() ?? "";
}

/**
 * Merge newly-discovered room directory names into an agent_map.md content string.
 * Rooms already present (matched by directory name in the Path column) are left
 * untouched; only missing rooms are appended to the room table. Returns the
 * original string unchanged when there is nothing new to add.
 */
export function mergeRoomsIntoMap(content: string, roomNames: string[]): string {
  const existingDirs = new Set(
    parseRoomTable(content).map((r) => roomDir(r["Path"] ?? "")).filter(Boolean),
  );
  const newRooms = roomNames.filter((n) => !existingDirs.has(n));
  if (newRooms.length === 0) return content;

  const lines = content.split("\n");
  let lastTableRow = -1;
  let inRoomSection = false;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "## Rooms") { inRoomSection = true; continue; }
    if (inRoomSection && line.startsWith("## ")) break;
    if (inRoomSection && line.includes("| Room")) { inTable = true; continue; }
    if (inTable) {
      if (line.trim().startsWith("|")) { lastTableRow = i; }
      else if (lastTableRow >= 0) break; // blank / non-pipe line after rows = end
    }
  }

  if (lastTableRow === -1) return content; // no table found — bail

  const newRows = newRooms.map((name) => `| ${name} | ~/rooms/${name}/ | |`);
  return [
    ...lines.slice(0, lastTableRow + 1),
    ...newRows,
    ...lines.slice(lastTableRow + 1),
  ].join("\n");
}

/** Immediate subdirectories of `~/workspace` (any dir counts as a project). */
export function discoverWorkspaceProjects(env: Environment): string[] {
  if (!existsSync(env.workspace)) return [];
  const out: string[] = [];
  for (const name of readdirSync(env.workspace)) {
    const p = join(env.workspace, name);
    try {
      if (statSync(p).isDirectory()) out.push(p);
    } catch {
      // skip unreadable entries
    }
  }
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Immediate signature-bearing subdirectories of the home root. */
export function discoverHomeProjects(env: Environment): string[] {
  if (!existsSync(env.root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(env.root)) {
    const p = join(env.root, name);
    if (isProjectDir(env, p)) out.push(p);
  }
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Workspace + home projects, de-duplicated by basename (workspace wins). */
export function discoverAll(env: Environment): string[] {
  const workspace = discoverWorkspaceProjects(env);
  const names = new Set(workspace.map((p) => basename(p).toLowerCase()));
  const all = [...workspace];
  for (const h of discoverHomeProjects(env)) {
    if (!names.has(basename(h).toLowerCase())) all.push(h);
  }
  return all;
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? "";
}

// ── Beacon generation ────────────────────────────────────────────────────────

/** Generate the home AGENTS.md from agent_map.md room/project tables. Ends with {@link SYNC_STAMP}. */
export function generateHomeAgentsMd(
  env: Environment,
  rooms: TableRow[],
  projects: TableRow[],
): string {
  const home = env.homeStr;
  const lines: string[] = [
    "# AGENTS.md — Machine Orientation for AI Agents",
    "",
    "> **READ THIS FILE FIRST.** Entry point to this machine's agent context.",
    "",
    "## Quick Orientation",
    "",
    "This machine uses a layered structure for AI agent context:",
    "",
    `1. **The Map:** \`${home}/agent_map.md\` — routing, room index, project table`,
    `2. **The Rooms:** \`${home}/rooms/<domain>/\` — domain rules, skills, constraints`,
    `3. **The Workspace:** \`${home}/workspace/<project>/\` — active project files`,
    `4. **The Data Layer:** \`${home}/data/\` — structured, queryable data`,
    "",
    "## Startup Protocol",
    "",
    `1. **Read the Map:** \`cat ${home}/agent_map.md\``,
    "2. **Identify your task's room** from the room index",
    `3. **Read the room rules:** \`cat ${home}/rooms/<domain>/room_rules.md\``,
    "",
    ...EXTEND_GUARDRAIL,
    "",
    "## Room Index",
    "",
    "| Room | Path | Purpose |",
    "|------|------|---------|",
  ];
  for (const r of rooms) {
    lines.push(`| ${r["Room"] ?? ""} | ${r["Path"] ?? ""} | ${r["Purpose"] ?? ""} |`);
  }
  lines.push("", "## Project Index", "", "| Project | Path | Status |", "|---------|------|--------|");
  for (const p of projects) {
    const path = p["Path"] ?? p["Workspace"] ?? "";
    lines.push(`| ${p["Project"] ?? ""} | ${path} | ${p["Status"] ?? ""} |`);
  }
  lines.push("", SYNC_STAMP, "");
  return lines.join("\n");
}

/** Generate the home CLAUDE.md. Ends with {@link SYNC_STAMP}. */
export function generateHomeClaudeMd(env: Environment): string {
  const home = env.homeStr;
  return [
    "# CLAUDE.md — Machine Orientation",
    "",
    `> **Read \`${home}/agent_map.md\` first.** Full routing table and room index.`,
    "",
    "## Quick Start",
    "",
    `1. \`cat ${home}/agent_map.md\` — read the map`,
    "2. Identify which room your task belongs to",
    `3. \`cat ${home}/rooms/<domain>/room_rules.md\` — read domain rules`,
    `4. \`cd ${home}/workspace/<project>/\` — work in the workspace`,
    "",
    "## Key Conventions",
    "",
    "- **Workspace-first:** active work happens in `~/workspace/<project>/`",
    "- **Room rules are mandatory** — each domain has its own `room_rules.md`",
    "",
    ...EXTEND_GUARDRAIL,
    "",
    SYNC_STAMP,
    "",
  ].join("\n");
}

/** Generate the home .cursorrules. Ends with {@link SYNC_STAMP}. */
export function generateCursorrules(env: Environment, rooms: TableRow[]): string {
  const roomNames = rooms.map((r) => r["Room"] ?? "").filter(Boolean);
  return [
    "# Machine Orientation (agent-env)",
    "",
    `1. Read \`${env.homeStr}/agent_map.md\` first.`,
    "2. Identify your task's room.",
    "3. Read that room's `room_rules.md`.",
    "4. Work in the project workspace.",
    "",
    roomNames.length ? `Rooms: ${roomNames.join(", ")}` : "Rooms: (none configured)",
    "",
    "Extending Harbor: use `harbor skill-install` / `harbor install --for <agent>` — never npx-global; read the `extending-harbor` skill; run `harbor sync` after.",
    "",
    SYNC_STAMP,
    "",
  ].join("\n");
}

/** Generate a per-project AGENTS.md stub. No {@link SYNC_STAMP} (project-level). */
export function generateProjectAgentsMd(env: Environment, projectName: string): string {
  const home = env.homeStr;
  return [
    `# ${projectName}`,
    "",
    "## Machine Orientation",
    "",
    `1. Read \`${home}/agent_map.md\` for routing.`,
    "2. Identify this project's room and read its rules.",
    "3. Work from this workspace directory.",
    "",
    "## Compaction Workflow",
    "",
    "1. Research → `research.md`",
    "2. Plan → `plan.md`",
    "3. Execute from the plan; dump large output to `scratchpad.md`.",
    "",
  ].join("\n");
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
 * Generate a room's skills_index.md from all skills assigned to the room
 * (explicit config list + category mappings), so the index matches what
 * `harbor skills-list --room <room>` reports. When per-skill sub-domain hints
 * are configured (`[skills.skill_subdomain]`), skills are grouped under `##`
 * sub-sections sorted alphabetically; hint-less skills fall under "## other"
 * (rendered last). With no hints configured the output is a flat list.
 */
export function generateRoomIndex(env: Environment, room: string): string {
  const { assignments } = computeAssignments(env);
  const skills = Object.entries(assignments)
    .filter(([, r]) => r === room)
    .map(([name]) => name)
    .sort();
  const lines = [`# ${room} — Skills Index`, ""];
  if (skills.length === 0) {
    lines.push("_No skills configured for this room._", "");
    return lines.join("\n");
  }

  const hints = env.config.skillSubdomains;
  const grouped: Record<string, string[]> = {};
  for (const s of skills) {
    const hint = hints[s];
    const group = hint ? subdomainLabel(hint) || "other" : "other";
    (grouped[group] ??= []).push(s);
  }
  const groups = Object.keys(grouped);

  // No hints at all → preserve the flat list (back-compat).
  if (groups.length === 1 && groups[0] === "other") {
    for (const s of skills) lines.push(`- ${s}`);
    lines.push("");
    return lines.join("\n");
  }

  // "other" sorts last; the rest alphabetically.
  const ordered = groups.sort((a, b) =>
    a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b),
  );
  for (const g of ordered) {
    lines.push(`## ${g}`, "");
    for (const s of (grouped[g] as string[]).sort()) lines.push(`- ${s}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Filesystem helpers (idempotent) ──────────────────────────────────────────

/** Write `content` to `path` only if it differs from what's there. Returns true if written. */
export function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === content) return false;
    } catch {
      // fall through and rewrite
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

/** Point `linkPath` at `target` as a symlink, replacing any existing entry. */
export function ensureSymlink(linkPath: string, target: string): void {
  try {
    if (lstatSync(linkPath)) rmSync(linkPath, { force: true });
  } catch {
    // nothing there
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface GenerateResult {
  /** Absolute path → whether the file was (re)written this run. */
  written: Record<string, boolean>;
}

/**
 * Regenerate the home beacons from the *existing* agent_map.md (the
 * `--generate-only` path). Does no discovery and does not modify agent_map.md.
 */
export function runGenerate(env: Environment): GenerateResult {
  const mapContent = existsSync(env.agentMap) ? readFileSync(env.agentMap, "utf8") : "";
  const rooms = parseRoomTable(mapContent);
  const projects = parseProjectTable(mapContent);

  const written: Record<string, boolean> = {};
  const targets = new Set(env.config.homeBeaconTargets);
  if (targets.has("AGENTS.md")) {
    written[join(env.root, "AGENTS.md")] = writeIfChanged(
      join(env.root, "AGENTS.md"),
      generateHomeAgentsMd(env, rooms, projects),
    );
  }
  if (targets.has("CLAUDE.md")) {
    written[join(env.root, "CLAUDE.md")] = writeIfChanged(
      join(env.root, "CLAUDE.md"),
      generateHomeClaudeMd(env),
    );
  }
  if (targets.has(".cursorrules")) {
    written[join(env.root, ".cursorrules")] = writeIfChanged(
      join(env.root, ".cursorrules"),
      generateCursorrules(env, rooms),
    );
  }

  // Room skill indexes (config-driven; no-op when no rooms configured).
  for (const room of Object.keys(env.config.roomSkills)) {
    const p = join(env.rooms, room, "skills_index.md");
    written[p] = writeIfChanged(p, generateRoomIndex(env, room));
  }
  return { written };
}

/**
 * Scaffold a workspace project directory: three compaction stubs plus an
 * AGENTS.md *symlink* to the home beacon. Only ever call with an explicit
 * project directory under a controlled root — never a watched real home.
 */
export function ensureWorkspaceDir(env: Environment, projectDir: string): void {
  mkdirSync(projectDir, { recursive: true });
  const name = basename(projectDir);
  const stubs: Record<string, string> = {
    "research.md": `# Research\n\n# ${name}\n\n`,
    "plan.md": `# Plan\n\n# ${name}\n\n`,
    "scratchpad.md": `# Scratchpad\n\n# ${name}\n\n`,
  };
  for (const [file, content] of Object.entries(stubs)) {
    const p = join(projectDir, file);
    if (!existsSync(p)) writeFileSync(p, content);
  }
  const homeBeacon = join(env.root, env.config.projectBeacon);
  ensureSymlink(join(projectDir, env.config.projectBeacon), homeBeacon);
}

/**
 * Full sync: discover rooms + projects, update agent_map.md, scaffold workspace
 * dirs, then regenerate beacons.
 */
export function fullSync(env: Environment): { projects: string[]; generate: GenerateResult } {
  // Merge any newly-discovered rooms (~/rooms/<name>/room_rules.md) into agent_map.md.
  if (existsSync(env.agentMap)) {
    const content = readFileSync(env.agentMap, "utf8");
    writeIfChanged(env.agentMap, mergeRoomsIntoMap(content, discoverRooms(env)));
  }

  const generate = runGenerate(env);
  const projects = discoverWorkspaceProjects(env);
  for (const dir of projects) ensureWorkspaceDir(env, dir);
  return { projects, generate };
}
