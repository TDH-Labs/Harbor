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

/**
 * A room name may only be a simple slug — letters, digits, hyphen, underscore
 * — never a path separator or a `..` segment. A room name becomes BOTH a
 * directory segment (`env.rooms/<room>/room_rules.md`) and a TOML section key
 * (`[skills.rooms.<room>]`); unsanitized input at either of those two entry
 * points is the identical `..`-escape / injection class the isolation
 * boundary was hardened against elsewhere.
 *
 * `isValidRoomName` is the shared predicate — callers with their own error
 * type (skill-install.ts, skill-room-add.ts) check it before touching the
 * filesystem/config with an unvalidated room string, so the failure is a
 * clear domain error, not a path escaping into an existsSync probe.
 * `validateRoomName` (throwing {@link ConfigEditError}) is additionally
 * called INSIDE the config-write primitives below, so every caller — current
 * and future, including ones that forget to check first — is protected
 * structurally, the same "harden at the primitive" pattern gate.ts's
 * ROOM_OVERRIDE_GATED_TOOLS uses for list_skills.
 */
const ROOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidRoomName(room: string): boolean {
  return ROOM_NAME_RE.test(room);
}

export function validateRoomName(room: string): void {
  if (!isValidRoomName(room)) {
    throw new ConfigEditError(
      `invalid room name '${room}' — room names may only contain letters, digits, hyphens, and underscores`,
    );
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
  validateRoomName(room);
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
  validateRoomName(room);
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

/** A third-party MCP server entry, as written into `[[skills.rooms.<room>.mcp.servers]]`. */
export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Add or update a third-party MCP server entry under
 * `[[skills.rooms.<room>.mcp.servers]]` in the environment's config.toml —
 * the structural, sanctioned way to do what previously required a hand-edit.
 *
 * Upsert by `server.name`: a room's server list holds at most one entry per
 * name. No existing entry with that name → appended. An existing entry that's
 * byte-for-byte identical → no-op (`changed:false`), matching every other
 * mutation in this file. An existing entry that differs → replaced — this
 * command IS the update path too, there's no separate `mcp-update`.
 *
 * Throws {@link ConfigEditError} if no config file is associated with the
 * environment or the room section is absent (use {@link ensureRoomInConfig}
 * first when the room may not exist yet — the same precondition
 * {@link addSkillToRoom} has).
 */
export function addMcpServerToRoom(env: Environment, room: string, server: McpServerSpec): EditResult {
  validateRoomName(room);
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
  roomTable.mcp ??= {};
  const mcpTable = roomTable.mcp as TomlTable;
  const servers: TomlTable[] = Array.isArray(mcpTable.servers) ? mcpTable.servers : [];

  const idx = servers.findIndex((s) => s.name === server.name);
  if (idx >= 0 && JSON.stringify(servers[idx]) === JSON.stringify(server)) {
    return { changed: false, path };
  }

  const nextServers = [...servers];
  if (idx >= 0) {
    nextServers[idx] = server;
  } else {
    nextServers.push(server);
  }
  mcpTable.servers = nextServers;

  writeFileSync(path, stringifyToml(data) + "\n");
  return { changed: true, path };
}

/**
 * Remove the MCP server named `name` from `[skills.rooms.<room>].mcp.servers`.
 * Idempotent — returns `changed: false` if the room has no such server (or no
 * server list at all). Throws {@link ConfigEditError} if the environment has no
 * config file or the room section is absent.
 */
export function removeMcpServerFromRoom(env: Environment, room: string, name: string): EditResult {
  validateRoomName(room);
  const path = env.configPath;
  if (!path) {
    throw new ConfigEditError("no config file path available (environment built from defaults)");
  }

  const data = parseToml(readFileSync(path, "utf8")) as TomlTable;
  const rooms = data?.skills?.rooms as TomlTable | undefined;
  if (!rooms || typeof rooms !== "object" || !(room in rooms)) {
    throw new ConfigEditError(`room section '[skills.rooms.${room}]' not found in config`);
  }

  const roomTable = rooms[room] as TomlTable;
  const mcpTable = roomTable.mcp as TomlTable | undefined;
  const servers: TomlTable[] = Array.isArray(mcpTable?.servers) ? (mcpTable.servers as TomlTable[]) : [];
  const nextServers = servers.filter((s) => s.name !== name);
  if (nextServers.length === servers.length) {
    return { changed: false, path };
  }

  (roomTable.mcp as TomlTable).servers = nextServers;
  writeFileSync(path, stringifyToml(data) + "\n");
  return { changed: true, path };
}

/**
 * Remove `skill` from `[skills.rooms.<room>].skills` in the environment's
 * config.toml, if present.
 *
 * Throws {@link ConfigEditError} if no config file is associated with the
 * environment or the room section is absent. Removing a skill not currently
 * in the list is a no-op (`changed:false`) — symmetric with
 * {@link addSkillToRoom}.
 */
export function removeSkillFromRoom(env: Environment, skill: string, room: string): EditResult {
  validateRoomName(room);
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
  if (!skills.includes(skill)) {
    return { changed: false, path };
  }
  roomTable.skills = skills.filter((s) => s !== skill);

  writeFileSync(path, stringifyToml(data) + "\n");
  return { changed: true, path };
}

/**
 * Merge `map` (skill → sub-domain hint) into `[skills.skill_subdomain]` in the
 * environment's config.toml in a single structured write. Existing entries are
 * overwritten by `map`; entries absent from `map` are left untouched. Returns
 * `changed:false` when the merge is already satisfied. Throws when there is no
 * config file.
 */
export function setSkillSubdomains(env: Environment, map: Record<string, string>): EditResult {
  const path = env.configPath;
  if (!path) {
    throw new ConfigEditError("no config file path available (environment built from defaults)");
  }
  const data = parseToml(readFileSync(path, "utf8")) as TomlTable;
  data.skills ??= {};
  const existing = (data.skills.skill_subdomain ?? {}) as Record<string, string>;
  let changed = false;
  for (const [skill, hint] of Object.entries(map)) {
    if (existing[skill] !== hint) {
      existing[skill] = hint;
      changed = true;
    }
  }
  if (!changed) return { changed: false, path };
  data.skills.skill_subdomain = existing;
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
