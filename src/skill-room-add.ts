/**
 * skill-room-add.ts — Grant an ALREADY-installed skill access to an additional
 * room.
 *
 * skill-install/skill-assign route a skill to its FIRST room; this handles the
 * later case — a skill already exists in the pool (granted somewhere, or not
 * yet granted anywhere), and a room that may not have existed at install time
 * (e.g. "legal" created after "security-gate" was installed into "devops")
 * should also be granted it. Additive only: never removes the skill from any
 * room it's already in — the physical skill directory in the pool is never
 * touched, only the target room's config entry.
 *
 * Security note: this does not touch isolation.ts's roomSkillAllowed, which
 * already reads each room's OWN config skills list directly (see skills.ts's
 * explicitSkillRooms doc for the full reasoning) — granting a second room here
 * is exactly as safe as the original single-room grant made at install time;
 * no gating code changes needed or made.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Environment } from "./env.ts";
import { addSkillToRoom, ensureRoomInConfig, isValidRoomName, reloadEnv } from "./config-edit.ts";
import { explicitSkillRooms, findSkillDir, generateRoomIndexes } from "./skills.ts";

export class SkillRoomAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRoomAddError";
  }
}

export interface RoomAddResult {
  skill: string;
  room: string;
  /** True if the room's config section didn't exist yet and was created. */
  roomCreated: boolean;
  /** False if the skill was already granted in this room (no-op, idempotent). */
  changed: boolean;
}

/**
 * Grant `skill` (must already exist in the pool) access to `room`, creating
 * the room's config section first if it doesn't exist yet in config but is
 * present on disk (`~/rooms/<room>/room_rules.md`) — the "room created after
 * the skill" case. Idempotent: granting an already-granted room is a no-op.
 * Regenerates the target room's index afterward so its docs reflect the grant
 * immediately, matching skill-install's ordering (config write → reload →
 * index is load-bearing — see skill-install.ts).
 */
export function addSkillToAnotherRoom(env: Environment, skill: string, room: string): RoomAddResult {
  if (!isValidRoomName(room)) {
    throw new SkillRoomAddError(
      `invalid room name '${room}' — room names may only contain letters, digits, hyphens, and underscores`,
    );
  }
  if (!findSkillDir(env, skill)) {
    throw new SkillRoomAddError(`skill '${skill}' not found in the pool`);
  }

  const roomInConfig = room in env.config.roomSkills;
  const roomOnDisk = existsSync(join(env.rooms, room, "room_rules.md"));
  if (!roomInConfig && !roomOnDisk) {
    throw new SkillRoomAddError(`room '${room}' not found in config or on disk`);
  }

  const roomCreated = !roomInConfig;
  if (roomCreated) ensureRoomInConfig(env, room);

  const { changed } = addSkillToRoom(env, skill, room);
  generateRoomIndexes(reloadEnv(env));

  return { skill, room, roomCreated, changed };
}

/** Every room a skill is already explicitly granted in (empty if none/unassigned). */
export function roomsForSkill(env: Environment, skill: string): string[] {
  return explicitSkillRooms(env.config)[skill] ?? [];
}

/** All configured rooms with their descriptions, for building a room picker. */
export function listConfiguredRooms(env: Environment): Array<{ room: string; description: string }> {
  return Object.entries(env.config.roomSkills).map(([room, data]) => ({
    room,
    description: data.description ?? "",
  }));
}
