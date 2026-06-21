/**
 * config-edit.ts — Safe, structured mutation of config.toml.
 *
 * The Phase 4 interface contract is explicit: "Config mutations use `smol-toml`
 * — never raw string manipulation." The Python prototype edited config.toml with
 * brittle `str.find`/`str.replace` surgery (and had special cases for empty vs.
 * multi-line skill lists). Here every mutation parses the file with `smol-toml`,
 * edits the in-memory structure, and re-serializes with `stringify`.
 *
 * Tradeoff (spec-silent, resolved here): a full parse→mutate→stringify does not
 * preserve comments or original key ordering in config.toml. That is the
 * accepted cost of structural correctness over fragile text editing — the
 * prototype's string surgery silently corrupted files on layouts it didn't
 * anticipate. Mutations are idempotent: adding a skill already present is a
 * no-op.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { Config } from "./config.ts";
import { Environment } from "./env.ts";

export class ConfigEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigEditError";
  }
}

/** Result of a config mutation. */
export interface EditResult {
  /** True if the file was changed (false when the edit was already satisfied). */
  changed: boolean;
  /** The config.toml path that was edited. */
  path: string;
}

type TomlTable = Record<string, any>;

/**
 * Ensure `[skills.rooms.<room>]` exists in the environment's config.toml,
 * creating it (with an empty skills list) if absent. Safe to call repeatedly —
 * no-op when the section already exists. Throws when there is no config file.
 */
export function ensureRoomInConfig(env: Environment, room: string): EditResult {
  const path = env.configPath;
  if (!path) {
    throw new ConfigEditError("no config file path available (environment built from defaults)");
  }

  const raw = readFileSync(path, "utf8");
  const data = parseToml(raw) as TomlTable;

  data.skills ??= {};
  data.skills.rooms ??= {};
  const rooms = data.skills.rooms as TomlTable;
  if (room in rooms) return { changed: false, path };

  rooms[room] = { skills: [] };
  writeFileSync(path, stringifyToml(data) + "\n");
  return { changed: true, path };
}

/**
 * Add `skill` to `[skills.rooms.<room>].skills` in the environment's config.toml.
 *
 * Throws {@link ConfigEditError} if no config file is associated with the
 * environment or the room section is absent. Use {@link ensureRoomInConfig}
 * first when the room may not exist yet. Adding a skill already in the list is
 * a no-op (`changed:false`).
 */
export function addSkillToRoom(env: Environment, skill: string, room: string): EditResult {
  const path = env.configPath;
  if (!path) {
    throw new ConfigEditError("no config file path available (environment built from defaults)");
  }

  const raw = readFileSync(path, "utf8");
  const data = parseToml(raw) as TomlTable;

  const rooms = data?.skills?.rooms as TomlTable | undefined;
  if (!rooms || typeof rooms !== "object" || !(room in rooms)) {
    throw new ConfigEditError(`room section '[skills.rooms.${room}]' not found in config`);
  }

  const roomTable = rooms[room] as TomlTable;
  const skills: string[] = Array.isArray(roomTable.skills) ? roomTable.skills : [];
  if (skills.includes(skill)) {
    return { changed: false, path };
  }
  roomTable.skills = [...skills, skill];

  writeFileSync(path, stringifyToml(data) + "\n");
  return { changed: true, path };
}

/**
 * Re-read an environment's config.toml into a fresh {@link Environment} on the
 * same root. Use after a mutation so in-memory config reflects what's on disk
 * (e.g. before regenerating room indexes). Returns the same env unchanged when
 * it has no associated config file.
 */
export function reloadEnv(env: Environment): Environment {
  if (!env.configPath) return env;
  return new Environment(env.root, Config.load(env.configPath), env.configPath);
}
