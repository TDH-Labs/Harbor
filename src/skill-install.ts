/**
 * skill-install.ts — Install a skill into the shared pool and route it to a room.
 *
 * Copies a skill from a source directory (or a single SKILL.md file, wrapped into
 * a directory) into the pool, routes it to a room (explicit, keyword-suggested,
 * or the default room), and regenerates room indexes.
 *
 * Behavioral reference: `skill_install.py`. The room routing reuses the
 * config-derived scoring from {@link ./skill-assign.ts} rather than the
 * prototype's hardcoded ROOM_SIGNALS, and config mutation goes through
 * `smol-toml` (BUILD_BRIEF / Phase 4 interface requirement — never string
 * surgery).
 *
 * Downstream contract: `install(env, name, source, options)` returns the
 * installed path and the room it was routed to.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Environment } from "./env.ts";
import { addSkillToRoom, ensureRoomInConfig, isValidRoomName, reloadEnv } from "./config-edit.ts";
import { generateRoomIndexes } from "./skills.ts";
import { deriveRoomSignals, scoreSkillForRooms } from "./skill-assign.ts";

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInstallError";
  }
}

export interface InstallOptions {
  /** Explicit target room. When omitted the room is suggested by keyword score. */
  room?: string;
  /** Report the planned source/destination/room without making changes. */
  dryRun?: boolean;
}

export interface InstallResult {
  name: string;
  /** Absolute source path resolved for the install. */
  source: string;
  /** Absolute destination path in the pool. */
  installedPath: string;
  /** Room the skill was (or would be) routed to. */
  room: string;
  /** True when this was a dry run (no filesystem/config changes were made). */
  dryRun: boolean;
}

/**
 * Decide which room a not-yet-installed skill should go to: explicit room wins;
 * otherwise score the skill name + description against the configured rooms and
 * take the best match; fall back to the default room. Only returns a configured
 * room name (so the subsequent config write succeeds), except the default room
 * which may not be configured.
 */
function routeRoom(env: Environment, name: string, description: string, explicit?: string): string {
  if (explicit) return explicit;
  const signals = deriveRoomSignals(env.config);
  const scores = scoreSkillForRooms(name, description, signals);
  if (scores.length > 0) return scores[0]!.room;
  return env.config.skillDefaultRoom;
}

/** Read a skill directory's SKILL.md description (best-effort, for routing). */
function readDescription(skillMdPath: string): string {
  try {
    const text = readFileSync(skillMdPath, "utf8");
    const m = text.match(/^description:\s*(.+)$/m);
    return m ? m[1]!.replace(/^["']|["']$/g, "").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Install a skill into the pool and route it to a room.
 *
 * `source` may be a directory (copied wholesale) or a single file (wrapped into
 * `<name>/SKILL.md`, with minimal frontmatter added when missing). Throws
 * {@link SkillInstallError} when the skill already exists in the pool, the source
 * is missing, or an explicit room is unknown. With `dryRun`, returns the planned
 * result and makes no changes.
 */
export function install(
  env: Environment,
  name: string,
  source: string,
  options: InstallOptions = {},
): InstallResult {
  const installedPath = join(env.skillsDir, name);

  if (!existsSync(source)) {
    throw new SkillInstallError(`source path does not exist: ${source}`);
  }
  // Accept rooms that exist on disk (~/rooms/<name>/room_rules.md) even when
  // not yet in config — create the entry automatically. Reject truly unknown
  // rooms (not in config AND not on disk) with the original error.
  if (options.room && !(options.room in env.config.roomSkills)) {
    if (!isValidRoomName(options.room)) {
      throw new SkillInstallError(
        `invalid room name '${options.room}' — room names may only contain letters, digits, hyphens, and underscores`,
      );
    }
    const roomOnDisk = existsSync(join(env.rooms, options.room, "room_rules.md"));
    if (!roomOnDisk) throw new SkillInstallError(`room '${options.room}' not found in config`);
    ensureRoomInConfig(env, options.room);
  }

  // Determine the description for routing (without copying anything yet).
  const sourceIsDir = statSync(source).isDirectory();
  const sourceSkillMd = sourceIsDir ? join(source, "SKILL.md") : source;
  const description = readDescription(sourceSkillMd);
  const room = routeRoom(env, name, description, options.room);

  if (options.dryRun) {
    return { name, source, installedPath, room, dryRun: true };
  }

  if (existsSync(installedPath)) {
    throw new SkillInstallError(`skill '${name}' already exists at ${installedPath}`);
  }

  mkdirSync(env.skillsDir, { recursive: true });
  if (sourceIsDir) {
    cpSync(source, installedPath, { recursive: true });
  } else {
    installSingleFile(source, name, installedPath);
  }

  // Route to room. addSkillToRoom creates the room section if absent, so any
  // named room (explicit or auto-routed) can be written immediately.
  // Skip only when room resolves to the built-in default (e.g. "general") and
  // that default has no config section — writing it would create a misleading
  // entry implying the default is curated.
  // ORDERING IS LOAD-BEARING: config write → reload → index must be synchronous.
  const isConfiguredRoom = room in env.config.roomSkills;
  const isDefaultRoom = room === env.config.skillDefaultRoom && !isConfiguredRoom;
  if (!isDefaultRoom) {
    addSkillToRoom(env, name, room);
    generateRoomIndexes(reloadEnv(env));
  } else {
    generateRoomIndexes(env);
  }

  return { name, source, installedPath, room, dryRun: false };
}

/** Wrap a single SKILL.md file into `<pool>/<name>/SKILL.md`, adding frontmatter if absent. */
export function installSingleFile(source: string, name: string, installedPath: string): void {
  const tmp = mkdtempSync(join(tmpdir(), "harbor-install-"));
  const staged = join(tmp, name);
  mkdirSync(staged, { recursive: true });
  let content = readFileSync(source, "utf8");
  if ((content.split("\n")[0] ?? "").trim() !== "---") {
    content = `---\nname: ${name}\ndescription: ${titleize(name)}\n---\n\n${content}`;
  }
  writeFileSync(join(staged, "SKILL.md"), content);
  cpSync(staged, installedPath, { recursive: true });
}

function titleize(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}
