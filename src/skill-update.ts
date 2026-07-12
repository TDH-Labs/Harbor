/**
 * skill-update.ts — Update or remove an already-installed skill in the pool.
 *
 * skill-install.ts covers the FIRST install; this covers what happens next —
 * overwriting a skill's content in place (the scaffold→fill workflow
 * skill-create.ts starts but never finishes), and unregistering/deleting a
 * skill that's no longer wanted. Both operate on a skill already present in
 * the pool (found via {@link findSkillDir}), never on a fresh source.
 */
import { cpSync, existsSync, rmSync, statSync } from "node:fs";

import type { Environment } from "./env.ts";
import { isValidRoomName, reloadEnv, removeSkillFromRoom } from "./config-edit.ts";
import { installSingleFile } from "./skill-install.ts";
import { roomsForSkill } from "./skill-room-add.ts";
import { findSkillDir, generateRoomIndexes } from "./skills.ts";

export class SkillUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillUpdateError";
  }
}

export class SkillRemoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRemoveError";
  }
}

export interface UpdateOptions {
  /** Report the planned overwrite without making changes. */
  dryRun?: boolean;
}

export interface UpdateResult {
  name: string;
  source: string;
  installedPath: string;
  dryRun: boolean;
}

/**
 * Overwrite an already-installed skill's pool content with `source` (a
 * directory copied wholesale, or a single file wrapped into `SKILL.md` —
 * same rules as {@link install} in skill-install.ts). Room grants are
 * untouched. Throws {@link SkillUpdateError} when the skill isn't in the pool
 * yet (use skill-install for that) or the source path is missing.
 */
export function update(env: Environment, name: string, source: string, options: UpdateOptions = {}): UpdateResult {
  const installedPath = findSkillDir(env, name);
  if (!installedPath) {
    throw new SkillUpdateError(`skill '${name}' not found in the pool — use skill-install to add it first`);
  }
  if (!existsSync(source)) {
    throw new SkillUpdateError(`source path does not exist: ${source}`);
  }

  if (options.dryRun) {
    return { name, source, installedPath, dryRun: true };
  }

  rmSync(installedPath, { recursive: true, force: true });
  if (statSync(source).isDirectory()) {
    cpSync(source, installedPath, { recursive: true });
  } else {
    installSingleFile(source, name, installedPath);
  }

  return { name, source, installedPath, dryRun: false };
}

export interface RemoveOptions {
  /** Only unregister from this room; pool files and other room grants are untouched. */
  room?: string;
}

export interface RemoveResult {
  skill: string;
  /** Rooms actually unregistered (subset of the rooms the skill was granted in). */
  roomsUnregistered: string[];
  /** True when the pool directory was deleted. */
  poolDeleted: boolean;
}

/**
 * Remove a skill. With `options.room`, only unregisters it from that room
 * (config only — pool files and any other room's grant are untouched, since
 * other rooms may still depend on it). Without `options.room`, unregisters it
 * from every room it's granted in AND deletes its pool directory — full
 * removal. Throws {@link SkillRemoveError} if the skill isn't found in the
 * pool, or (room-scoped) if that room doesn't have it configured at all.
 */
export function removeSkill(env: Environment, name: string, options: RemoveOptions = {}): RemoveResult {
  if (!findSkillDir(env, name)) {
    throw new SkillRemoveError(`skill '${name}' not found in the pool`);
  }

  if (options.room) {
    if (!isValidRoomName(options.room)) {
      throw new SkillRemoveError(
        `invalid room name '${options.room}' — room names may only contain letters, digits, hyphens, and underscores`,
      );
    }
    if (!(options.room in env.config.roomSkills)) {
      throw new SkillRemoveError(`room '${options.room}' not found in config`);
    }
    const { changed } = removeSkillFromRoom(env, name, options.room);
    if (changed) generateRoomIndexes(reloadEnv(env));
    return { skill: name, roomsUnregistered: changed ? [options.room] : [], poolDeleted: false };
  }

  // Full removal: unregister from every room the skill is granted in, then
  // delete the pool directory. ORDERING IS LOAD-BEARING (see skill-install.ts):
  // each config write must be followed by a reload before the next read.
  let workingEnv = env;
  const unregistered: string[] = [];
  for (const room of roomsForSkill(env, name)) {
    const { changed } = removeSkillFromRoom(workingEnv, name, room);
    if (changed) unregistered.push(room);
    workingEnv = reloadEnv(workingEnv);
  }

  const installedPath = findSkillDir(workingEnv, name);
  let poolDeleted = false;
  if (installedPath) {
    rmSync(installedPath, { recursive: true, force: true });
    poolDeleted = true;
  }

  generateRoomIndexes(reloadEnv(workingEnv));

  return { skill: name, roomsUnregistered: unregistered, poolDeleted };
}
