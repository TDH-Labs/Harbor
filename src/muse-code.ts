/**
 * muse-code.ts — Harbor ↔ Muse Code skill sync.
 *
 * Muse Code discovers skills ON THE FILESYSTEM: every skill in
 * `$HOME/.agents/skills` loads as a user skill, and when the workspace is the
 * (trusted) home root the same pool also surfaces as project skills under
 * `.agents/skills`. That directory is Harbor's shared pool, so without this
 * module Muse loads the ENTIRE pool (~125 skills, ~14k startup tokens)
 * regardless of room — while every other Harbor agent reads only its room's
 * skills through the gated MCP server.
 *
 * The fix is Muse's own activation mechanism, maintained by Harbor:
 * `~/.config/muse/settings.json` carries
 * `skills.activation.user["$HOME/.agents/skills/<name>/SKILL.md"]` and
 * `skills.activation.projects["<home>"][".agents/skills/<name>/SKILL.md"]`
 * (verified live against muse 1.4.10: a trusted home-root workspace reports
 * the pool as project scope and ignores user-scope entries, so BOTH maps are
 * written). Harbor sets "off" for every pool skill outside the target room
 * and removes the entry (Muse defaults to on) for the room's skills.
 *
 * Boundaries:
 *   - Only activation keys for skills actually in Harbor's pool are managed.
 *     Every other settings key, activation entry, bundled skill, and plugin
 *     is preserved byte-for-byte at the JSON-value level.
 *   - Nothing in the pool or any other agent's config is touched; other
 *     agents keep reading the pool exactly as before.
 *   - Muse has no verified stdio-MCP wiring in settings.json (its
 *     `mcpServers` entries are streamable-HTTP), so Harbor scopes Muse's
 *     NATIVE skill loading instead of replacing it with the MCP gate. This
 *     is a loading-scope boundary, not an OS sandbox: Muse still reads the
 *     enabled skills' files directly, like Claude Code does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Environment } from "./env.ts";
import { getAllSkillNames, listSkills } from "./skills.ts";

/** Muse's per-user config file, relative to the environment root. */
export function museSettingsPath(root: string): string {
  return join(root, ".config", "muse", "settings.json");
}

/** Harbor state file recording the room chosen via `harbor install --for muse-code --room X --write`. */
export function museStatePath(env: Environment): string {
  return join(env.stateDir, "muse-code.json");
}

/**
 * The room Muse is scoped to: an explicit choice first, then the room
 * persisted by a previous `install --write`, then the environment's
 * configured default room. An unknown room falls back to the default room so
 * a stale state file can never leave Muse scoped to nothing.
 */
export function resolveMuseRoom(env: Environment, explicit?: string): string {
  const candidate = explicit?.trim() || readPersistedRoom(env) || env.config.skillDefaultRoom;
  return env.config.hasRoom(candidate) ? candidate : env.config.skillDefaultRoom;
}

/** Persist the room chosen at install time so `harbor sync` keeps using it. */
export function persistMuseRoom(env: Environment, room: string): void {
  const path = museStatePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ room }, null, 2) + "\n");
}

function readPersistedRoom(env: Environment): string | null {
  try {
    const doc = JSON.parse(readFileSync(museStatePath(env), "utf8")) as { room?: unknown };
    return typeof doc.room === "string" && doc.room.trim() ? doc.room.trim() : null;
  } catch {
    return null;
  }
}

export interface MuseActivation {
  room: string;
  /** Pool skills enabled for the room (no activation entry; Muse defaults to on). */
  enabled: string[];
  /** Pool skills disabled with an explicit "off" entry. */
  disabled: string[];
  /** settings.json `skills.activation.user` entries Harbor manages. */
  user: Record<string, string>;
  /** settings.json `skills.activation.projects[<root>]` entries Harbor manages. */
  project: Record<string, string>;
}

/** Muse's activation key for a pool skill at user scope. */
export function museUserKey(skill: string): string {
  return `$HOME/.agents/skills/${skill}/SKILL.md`;
}

/** Muse's activation key for a pool skill at home-root project scope. */
export function museProjectKey(skill: string): string {
  return `.agents/skills/${skill}/SKILL.md`;
}

/** Compute the activation maps for `room` from the live pool. */
export function computeMuseActivation(env: Environment, room: string): MuseActivation {
  const pool = getAllSkillNames(env);
  const enabled = new Set(listSkills(env, room).map((s) => s.name));
  const user: Record<string, string> = {};
  const project: Record<string, string> = {};
  const disabled: string[] = [];
  for (const skill of pool) {
    if (enabled.has(skill)) continue;
    disabled.push(skill);
    user[museUserKey(skill)] = "off";
    project[museProjectKey(skill)] = "off";
  }
  return { room, enabled: pool.filter((s) => enabled.has(s)), disabled, user, project };
}

/**
 * Merge `activation` into an existing settings.json document (parsed value).
 * Only pool-skill keys are set/removed; all other content is preserved.
 * Returns the merged document and whether it differs from the input.
 */
export function mergeMuseActivation(
  doc: Record<string, unknown>,
  root: string,
  pool: string[],
  activation: MuseActivation,
): { doc: Record<string, unknown>; changed: boolean } {
  const before = JSON.stringify(doc);
  const out = structuredClone(doc) as Record<string, Record<string, unknown>>;
  const skills = (out.skills ??= {}) as unknown as Record<string, Record<string, Record<string, string>>>;
  const act = (skills.activation ??= {}) as unknown as Record<string, Record<string, string>>;
  const user = (act.user ??= {}) as Record<string, string>;
  const projects = (act.projects ??= {}) as unknown as Record<string, Record<string, string>>;
  const project = (projects[root] ??= {}) as Record<string, string>;

  for (const skill of pool) {
    const uKey = museUserKey(skill);
    const pKey = museProjectKey(skill);
    if (activation.disabled.includes(skill)) {
      user[uKey] = "off";
      project[pKey] = "off";
    } else {
      delete user[uKey];
      delete project[pKey];
    }
  }
  if (Object.keys(project).length === 0) delete projects[root];
  return { doc: out as Record<string, unknown>, changed: JSON.stringify(out) !== before };
}

/** True when this machine has Muse state Harbor should keep in sync. */
export function museInstalled(root: string): boolean {
  return existsSync(join(root, ".config", "muse"));
}

export interface MuseSyncResult {
  path: string;
  room: string;
  enabled: number;
  disabled: number;
  /** "synced" (written/already current), "absent" (Muse not installed), "skipped" (unparseable settings — left untouched). */
  action: "synced" | "absent" | "skipped";
  changed: boolean;
}

/**
 * Bring Muse's settings.json in line with the pool + room. Called by
 * `harbor sync` (and therefore the watcher) so installing/removing a pool
 * skill re-scopes Muse automatically. No-op when Muse is not
 * installed; never clobbers an unparseable settings file.
 */
export function syncMuseCode(env: Environment, explicitRoom?: string): MuseSyncResult {
  const path = museSettingsPath(env.root);
  const room = resolveMuseRoom(env, explicitRoom);
  if (!museInstalled(env.root)) {
    return { path, room, enabled: 0, disabled: 0, action: "absent", changed: false };
  }
  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      doc = parsed as Record<string, unknown>;
    } catch {
      return { path, room, enabled: 0, disabled: 0, action: "skipped", changed: false };
    }
  }
  const activation = computeMuseActivation(env, room);
  const merged = mergeMuseActivation(doc, env.root, getAllSkillNames(env), activation);
  let changed = false;
  if (merged.changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged.doc, null, 2) + "\n");
    changed = true;
  }
  return { path, room, enabled: activation.enabled.length, disabled: activation.disabled.length, action: "synced", changed };
}
