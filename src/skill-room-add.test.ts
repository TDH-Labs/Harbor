import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config } from "./config.ts";
import { reloadEnv } from "./config-edit.ts";
import { Environment } from "./env.ts";
import { addSkillToAnotherRoom, listConfiguredRooms, roomsForSkill, SkillRoomAddError } from "./skill-room-add.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-sroomadd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envWithConfig(rooms: Record<string, { description: string; skills: string[] }>): Environment {
  const configPath = join(dir, "config.toml");
  const toml = [
    "[paths]",
    `home = "${dir}"`,
    'skills_dir = "~/.agents/skills"',
    'state_dir = "~/.agent-env"',
    "",
    "[skills]",
    'default_room = "general"',
    "",
    ...Object.entries(rooms).flatMap(([name, data]) => [
      `[skills.rooms.${name}]`,
      `description = "${data.description}"`,
      `skills = [${data.skills.map((s) => `"${s}"`).join(", ")}]`,
      "",
    ]),
  ].join("\n");
  writeFileSync(configPath, toml);
  return new Environment(dir, Config.load(configPath), configPath);
}

/** Place a skill directly in the pool (bypassing skill-install). */
function poolSkill(env: Environment, name: string): void {
  const d = join(env.skillsDir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: "${name}"\n---\n\n# ${name}\n`);
}

describe("addSkillToAnotherRoom", () => {
  test("grants a room already in config, without disturbing the original grant", () => {
    const e = envWithConfig({
      devops: { description: "Devops", skills: ["security-gate"] },
      legal: { description: "Legal", skills: [] },
    });
    poolSkill(e, "security-gate");

    const result = addSkillToAnotherRoom(e, "security-gate", "legal");
    expect(result).toMatchObject({ skill: "security-gate", room: "legal", roomCreated: false, changed: true });
    // config.toml is edited on disk; a real CLI invocation reads it fresh each
    // run — reload here rather than trust the pre-mutation in-memory `e`.
    expect(roomsForSkill(reloadEnv(e), "security-gate").sort()).toEqual(["devops", "legal"]);
  });

  test("is idempotent — adding an already-granted room is a no-op", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["security-gate"] } });
    poolSkill(e, "security-gate");
    const result = addSkillToAnotherRoom(e, "security-gate", "devops");
    expect(result.changed).toBe(false);
    expect(roomsForSkill(e, "security-gate")).toEqual(["devops"]);
  });

  test("creates the room's config section when it exists on disk but not in config yet", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["security-gate"] } });
    poolSkill(e, "security-gate");
    mkdirSync(join(e.rooms, "legal"), { recursive: true });
    writeFileSync(join(e.rooms, "legal", "room_rules.md"), "# Legal room\n");

    const result = addSkillToAnotherRoom(e, "security-gate", "legal");
    expect(result).toMatchObject({ roomCreated: true, changed: true });
    expect(roomsForSkill(reloadEnv(e), "security-gate").sort()).toEqual(["devops", "legal"]);
  });

  test("throws for a room neither in config nor on disk", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["security-gate"] } });
    poolSkill(e, "security-gate");
    expect(() => addSkillToAnotherRoom(e, "security-gate", "nonexistent")).toThrow(SkillRoomAddError);
  });

  test("throws for a skill that doesn't exist in the pool", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: [] } });
    expect(() => addSkillToAnotherRoom(e, "ghost-skill", "devops")).toThrow(SkillRoomAddError);
  });
});

describe("roomsForSkill / listConfiguredRooms", () => {
  test("roomsForSkill is empty for an unassigned skill", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: [] } });
    expect(roomsForSkill(e, "unassigned")).toEqual([]);
  });

  test("listConfiguredRooms reports every room with its description", () => {
    const e = envWithConfig({
      devops: { description: "Development tools", skills: [] },
      legal: { description: "Legal work", skills: [] },
    });
    expect(listConfiguredRooms(e).sort((a, b) => a.room.localeCompare(b.room))).toEqual([
      { room: "devops", description: "Development tools" },
      { room: "legal", description: "Legal work" },
    ]);
  });
});
