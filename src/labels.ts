/**
 * labels.ts — Report and edit sensitivity labels (see sensitivity.ts).
 *
 * The report answers the operator's question before it becomes an incident:
 * "which skills would a capped token be refused because I never labeled them?"
 * Edits go through smol-toml like every other config mutation (config-edit.ts),
 * so the file is never patched as text.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { ConfigEditError, validateRoomName, type EditResult } from "./config-edit.ts";
import { Environment } from "./env.ts";
import { effectiveSensitivity, isInvalidLabel, isSensitivity, SENSITIVITIES, type Sensitivity } from "./sensitivity.ts";
import { listSkills } from "./skills.ts";

type TomlTable = Record<string, any>;

/** A skill slug. The first character rules out `__proto__` and friends. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type LabelSource = "skill" | "room" | "none";

export interface LabelRow {
  room: string;
  skill: string;
  /** What a capped token sees: a tier, or null (unlabeled ⇒ refused under a ceiling). */
  label: Sensitivity | null;
  source: LabelSource;
  /** The configured value is present but not a tier, so it counts as `restricted`. */
  invalid: boolean;
}

export interface LabelReport {
  rows: LabelRow[];
  /** Rooms whose own `sensitivity` is present but not a tier. */
  invalidRooms: string[];
  /** Skills whose per-skill override is present but not a tier. */
  invalidSkills: string[];
  /** Override entries naming a skill that is not in the pool (a typo, or a removed skill). */
  strayOverrides: string[];
  unlabeled: number;
}

/**
 * Every (room, skill) pair with the label a capped token would meet, where it
 * came from, and what is wrong with the configuration.
 */
export function labelReport(env: Environment): LabelReport {
  const cfg = env.config;
  const rooms = cfg.roomSkills;
  const pool = new Set(listSkills(env).map((s) => s.name));

  const rows: LabelRow[] = [];
  for (const room of Object.keys(rooms).sort()) {
    for (const skill of [...(rooms[room]?.skills ?? [])].sort()) {
      const override = cfg.skillSensitivityRaw(skill);
      const hasOverride = override !== undefined && override !== null;
      const roomRaw = cfg.roomSensitivityRaw(room);
      const hasRoom = roomRaw !== undefined && roomRaw !== null;
      rows.push({
        room,
        skill,
        label: effectiveSensitivity(cfg, room, skill),
        source: hasOverride ? "skill" : hasRoom ? "room" : "none",
        invalid: hasOverride ? isInvalidLabel(override) : hasRoom ? isInvalidLabel(roomRaw) : false,
      });
    }
  }

  const overrides = cfg.data.skills.skill_sensitivity ?? {};
  const overrideNames = Object.keys(overrides);
  return {
    rows,
    invalidRooms: Object.keys(rooms).filter((r) => isInvalidLabel(cfg.roomSensitivityRaw(r))).sort(),
    invalidSkills: overrideNames.filter((k) => isInvalidLabel(overrides[k])).sort(),
    strayOverrides: overrideNames.filter((k) => !pool.has(k)).sort(),
    unlabeled: rows.filter((r) => r.label === null).length,
  };
}

function editable(env: Environment): { path: string; data: TomlTable } {
  const path = env.configPath;
  if (!path) throw new ConfigEditError("no config file path available (environment built from defaults)");
  return { path, data: parseToml(readFileSync(path, "utf8")) as TomlTable };
}

function requireTier(tier: string): Sensitivity {
  if (!isSensitivity(tier)) {
    throw new ConfigEditError(`invalid tier ${JSON.stringify(tier)} — use one of: ${SENSITIVITIES.join(", ")}`);
  }
  return tier;
}

/** Set (or, with `tier === null`, clear) a room's default label. The room must already exist. */
export function setRoomLabel(env: Environment, room: string, tier: string | null): EditResult {
  validateRoomName(room);
  const label = tier === null ? null : requireTier(tier);
  const { path, data } = editable(env);
  const rooms = data?.skills?.rooms as TomlTable | undefined;
  if (!rooms || typeof rooms !== "object" || !(room in rooms)) {
    throw new ConfigEditError(`room section '[skills.rooms.${room}]' not found in config`);
  }
  const table = rooms[room] as TomlTable;
  if (label === null) {
    if (!("sensitivity" in table)) return { changed: false, path };
    delete table.sensitivity;
  } else {
    if (table.sensitivity === label) return { changed: false, path };
    table.sensitivity = label;
  }
  writeFileSync(path, stringifyToml(data) + "\n");
  return { changed: true, path };
}

/**
 * Set (or clear) one skill's label, overriding its room's default. The skill must
 * be in the pool: an override for a name that does not exist would sit in the file
 * doing nothing, and look like protection.
 */
export function setSkillLabel(env: Environment, skill: string, tier: string | null): EditResult {
  if (!SKILL_NAME_RE.test(skill)) throw new ConfigEditError(`invalid skill name ${JSON.stringify(skill)}`);
  const label = tier === null ? null : requireTier(tier);
  const { path, data } = editable(env);

  if (label === null) {
    const table = data?.skills?.skill_sensitivity as TomlTable | undefined;
    if (!table || !Object.prototype.hasOwnProperty.call(table, skill)) return { changed: false, path };
    delete table[skill];
  } else {
    if (!listSkills(env).some((s) => s.name === skill)) {
      throw new ConfigEditError(`skill '${skill}' is not in the pool (see: harbor skills-list)`);
    }
    data.skills ??= {};
    data.skills.skill_sensitivity ??= {};
    const table = data.skills.skill_sensitivity as TomlTable;
    if (Object.prototype.hasOwnProperty.call(table, skill) && table[skill] === label) return { changed: false, path };
    table[skill] = label;
  }
  writeFileSync(path, stringifyToml(data) + "\n");
  return { changed: true, path };
}
