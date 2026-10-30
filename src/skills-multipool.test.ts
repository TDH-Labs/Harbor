import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { findDuplicateSkills, findSkillDir, getAllSkillNames, getSkill } from "./skills.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-multipool-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Environment with an explicit ordered list of skill pools. */
function envWithPools(pools: string[]): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { skills_dir: pools } }));
  return new Environment(dir, cfg);
}

function writeSkillAt(pool: string, name: string, body = `# ${name}`): string {
  const skillDir = join(pool, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`);
  return skillDir;
}

describe("multi-path skill pool", () => {
  test("skillsDir accepts a single string (legacy) and exposes one pool", () => {
    const pool = join(dir, "shared");
    const e = envWithPools([pool]);
    expect(e.skillsDirs).toEqual([pool]);
    expect(e.skillsDir).toBe(pool);
  });

  test("skillsDirs preserves order and resolves every entry", () => {
    const a = join(dir, "room-local");
    const b = join(dir, "shared");
    const e = envWithPools([a, b]);
    expect(e.skillsDirs).toEqual([a, b]);
    // skillsDir stays backward-compatible: first (highest precedence) pool.
    expect(e.skillsDir).toBe(a);
  });

  test("catalogues skills from every pool, not just the first", () => {
    const roomPool = join(dir, "room");
    const sharedPool = join(dir, "shared");
    writeSkillAt(roomPool, "room-only");
    writeSkillAt(sharedPool, "shared-only");
    const e = envWithPools([roomPool, sharedPool]);

    const names = getAllSkillNames(e);
    expect(names).toContain("room-only");
    expect(names).toContain("shared-only");
    expect(names).toEqual([...names].sort());
  });

  test("finds and loads a skill that exists only in a later pool", () => {
    const roomPool = join(dir, "room");
    const sharedPool = join(dir, "shared");
    writeSkillAt(sharedPool, "deep-skill", "# Deep\n\nbody text");

    const e = envWithPools([roomPool, sharedPool]);
    expect(findSkillDir(e, "deep-skill")).toBe(join(sharedPool, "deep-skill"));

    const detail = getSkill(e, "deep-skill");
    expect(detail).not.toBeNull();
    expect(detail?.content).toContain("body text");
  });

  test("first pool wins when a name exists in both", () => {
    const roomPool = join(dir, "room");
    const sharedPool = join(dir, "shared");
    writeSkillAt(roomPool, "shared-name", "ROOM VERSION");
    writeSkillAt(sharedPool, "shared-name", "POOL VERSION");

    const e = envWithPools([roomPool, sharedPool]);
    expect(findSkillDir(e, "shared-name")).toBe(join(roomPool, "shared-name"));
    expect(getSkill(e, "shared-name")?.content).toContain("ROOM VERSION");
  });

  test("duplicates are reported instead of silently resolved", () => {
    const roomPool = join(dir, "room");
    const sharedPool = join(dir, "shared");
    writeSkillAt(roomPool, "twin");
    writeSkillAt(sharedPool, "twin");
    writeSkillAt(sharedPool, "loner");

    const dups = findDuplicateSkills(envWithPools([roomPool, sharedPool]));
    expect(dups.map((d) => d.name)).toEqual(["twin"]);
    expect(dups[0]?.dirs).toEqual([join(roomPool, "twin"), join(sharedPool, "twin")]);
  });

  test("no duplicates reported for a single pool", () => {
    const pool = join(dir, "shared");
    writeSkillAt(pool, "solo");
    expect(findDuplicateSkills(envWithPools([pool]))).toEqual([]);
  });

  test("a missing pool in the list is skipped without throwing", () => {
    const real = join(dir, "real");
    writeSkillAt(real, "present");
    const e = envWithPools([join(dir, "does-not-exist"), real]);
    expect(getAllSkillNames(e)).toContain("present");
    expect(findSkillDir(e, "present")).toBe(join(real, "present"));
  });

  test("path traversal is still refused, per pool", () => {
    const roomPool = join(dir, "room");
    const sharedPool = join(dir, "shared");
    writeSkillAt(sharedPool, "legit");
    // A directory outside every pool that the traversal guard must not reach.
    const outside = join(dir, "outside", "secret-skill");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: secret-skill\n---\n");

    const e = envWithPools([roomPool, sharedPool]);
    expect(findSkillDir(e, "legit")).toBe(join(sharedPool, "legit"));
    expect(findSkillDir(e, "../../outside/secret-skill")).toBeNull();
  });

  test("a skill appears once in the catalogue even when duplicated across pools", () => {
    const roomPool = join(dir, "room");
    const sharedPool = join(dir, "shared");
    writeSkillAt(roomPool, "dup");
    writeSkillAt(sharedPool, "dup");
    const names = getAllSkillNames(envWithPools([roomPool, sharedPool]));
    expect(names.filter((n) => n === "dup")).toHaveLength(1);
  });
});
