import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config } from "./config.ts";
import { reloadEnv } from "./config-edit.ts";
import { Environment } from "./env.ts";
import { roomsForSkill } from "./skill-room-add.ts";
import { findSkillDir } from "./skills.ts";
import { removeSkill, SkillRemoveError, SkillUpdateError, update } from "./skill-update.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-supdate-"));
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
function poolSkill(env: Environment, name: string, body = `# ${name}\n`): void {
  const d = join(env.skillsDir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: "${name}"\n---\n\n${body}`);
}

describe("update", () => {
  test("overwrites an installed skill's content from a source directory", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["gate"] } });
    poolSkill(e, "gate", "# stub\n");
    const sourceDir = mkdtempSync(join(tmpdir(), "harbor-supdate-src-"));
    writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: gate\ndescription: real\n---\n\n# Real content\n");

    const res = update(e, "gate", sourceDir);
    expect(res.dryRun).toBe(false);
    expect(readFileSync(join(res.installedPath, "SKILL.md"), "utf8")).toContain("Real content");
  });

  test("overwrites from a single SKILL.md file, wrapping frontmatter if absent", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["gate"] } });
    poolSkill(e, "gate", "# stub\n");
    const sourceFile = join(mkdtempSync(join(tmpdir(), "harbor-supdate-src-")), "gate.md");
    writeFileSync(sourceFile, "# Filled in for real\n");

    const res = update(e, "gate", sourceFile);
    const content = readFileSync(join(res.installedPath, "SKILL.md"), "utf8");
    expect(content).toContain("Filled in for real");
    expect(content).toMatch(/^---/);
  });

  test("dry run reports the plan and makes no changes", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["gate"] } });
    poolSkill(e, "gate", "# stub\n");
    const sourceDir = mkdtempSync(join(tmpdir(), "harbor-supdate-src-"));
    writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: gate\ndescription: real\n---\n\n# Real\n");

    const res = update(e, "gate", sourceDir, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(readFileSync(join(res.installedPath, "SKILL.md"), "utf8")).toContain("stub");
  });

  test("throws when the skill isn't in the pool yet", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: [] } });
    const sourceDir = mkdtempSync(join(tmpdir(), "harbor-supdate-src-"));
    expect(() => update(e, "ghost", sourceDir)).toThrow(SkillUpdateError);
  });

  test("throws when the source path doesn't exist", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["gate"] } });
    poolSkill(e, "gate");
    expect(() => update(e, "gate", join(dir, "nope"))).toThrow(SkillUpdateError);
  });

  test("does not touch room grants", () => {
    const e = envWithConfig({
      devops: { description: "Devops", skills: ["gate"] },
      legal: { description: "Legal", skills: ["gate"] },
    });
    poolSkill(e, "gate", "# stub\n");
    const sourceDir = mkdtempSync(join(tmpdir(), "harbor-supdate-src-"));
    writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: gate\ndescription: real\n---\n\n# Real\n");

    update(e, "gate", sourceDir);
    expect(roomsForSkill(e, "gate").sort()).toEqual(["devops", "legal"]);
  });
});

describe("removeSkill", () => {
  test("room-scoped: unregisters from only that room, leaves pool files and other rooms untouched", () => {
    const e = envWithConfig({
      devops: { description: "Devops", skills: ["gate"] },
      legal: { description: "Legal", skills: ["gate"] },
    });
    poolSkill(e, "gate");

    const res = removeSkill(e, "gate", { room: "devops" });
    expect(res).toEqual({ skill: "gate", roomsUnregistered: ["devops"], poolDeleted: false });
    const fresh = reloadEnv(e);
    expect(roomsForSkill(fresh, "gate")).toEqual(["legal"]);
    expect(findSkillDir(fresh, "gate")).not.toBeNull();
  });

  test("room-scoped: is idempotent — removing from a room it's not granted in is a no-op", () => {
    const e = envWithConfig({
      devops: { description: "Devops", skills: ["gate"] },
      legal: { description: "Legal", skills: [] },
    });
    poolSkill(e, "gate");
    const res = removeSkill(e, "gate", { room: "legal" });
    expect(res).toEqual({ skill: "gate", roomsUnregistered: [], poolDeleted: false });
  });

  test("room-scoped: throws for a room not in config", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["gate"] } });
    poolSkill(e, "gate");
    expect(() => removeSkill(e, "gate", { room: "ghost-room" })).toThrow(SkillRemoveError);
  });

  test("room-scoped: rejects a `..`-bearing room name", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: ["gate"] } });
    poolSkill(e, "gate");
    expect(() => removeSkill(e, "gate", { room: "../escape" })).toThrow(SkillRemoveError);
  });

  test("full removal: unregisters from every room and deletes the pool directory", () => {
    const e = envWithConfig({
      devops: { description: "Devops", skills: ["gate"] },
      legal: { description: "Legal", skills: ["gate"] },
    });
    poolSkill(e, "gate");

    const res = removeSkill(e, "gate");
    expect(res.poolDeleted).toBe(true);
    expect(res.roomsUnregistered.sort()).toEqual(["devops", "legal"]);
    const fresh = reloadEnv(e);
    expect(roomsForSkill(fresh, "gate")).toEqual([]);
    expect(findSkillDir(fresh, "gate")).toBeNull();
    expect(existsSync(join(e.skillsDir, "gate"))).toBe(false);
  });

  test("full removal: deletes pool files even for a skill granted in no room", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: [] } });
    poolSkill(e, "gate");
    const res = removeSkill(e, "gate");
    expect(res).toEqual({ skill: "gate", roomsUnregistered: [], poolDeleted: true });
    expect(existsSync(join(e.skillsDir, "gate"))).toBe(false);
  });

  test("throws when the skill isn't in the pool", () => {
    const e = envWithConfig({ devops: { description: "Devops", skills: [] } });
    expect(() => removeSkill(e, "ghost")).toThrow(SkillRemoveError);
  });
});
