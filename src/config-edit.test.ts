import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { Config } from "./config.ts";
import { Environment } from "./env.ts";
import { addSkillToRoom, ConfigEditError, reloadEnv } from "./config-edit.ts";

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-cedit-"));
  configPath = join(dir, "config.toml");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(body: string): Environment {
  writeFileSync(configPath, body);
  return new Environment(dir, Config.load(configPath), configPath);
}

const BASE = `[paths]
home = "${"PLACEHOLDER"}"
skills_dir = "~/.agents/skills"
state_dir = "~/.agent-env"

[skills.rooms.ops]
description = "Ops"
skills = ["existing"]

[skills.rooms.empty]
description = "Empty"
skills = []
`;

describe("addSkillToRoom", () => {
  test("appends to a populated list and round-trips through smol-toml", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    const res = addSkillToRoom(e, "newone", "ops");
    expect(res.changed).toBe(true);
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.ops.skills).toEqual(["existing", "newone"]);
    // other room untouched
    expect(cfg.skills.rooms.empty.skills).toEqual([]);
  });

  test("converts an empty list correctly", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    addSkillToRoom(e, "first", "empty");
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.empty.skills).toEqual(["first"]);
  });

  test("is idempotent — adding an existing skill is a no-op", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    const res = addSkillToRoom(e, "existing", "ops");
    expect(res.changed).toBe(false);
  });

  test("throws for an unknown room", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    expect(() => addSkillToRoom(e, "x", "ghost")).toThrow(ConfigEditError);
  });

  test("throws when the environment has no config file", () => {
    const e = new Environment(dir, Config.defaults(), null);
    expect(() => addSkillToRoom(e, "x", "ops")).toThrow(/no config file/);
  });
});

describe("reloadEnv", () => {
  test("reflects an on-disk mutation in a fresh environment", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    addSkillToRoom(e, "added", "ops");
    // stale in-memory env still shows the old list
    expect(e.config.roomSkillSet("ops").has("added")).toBe(false);
    const fresh = reloadEnv(e);
    expect(fresh.config.roomSkillSet("ops").has("added")).toBe(true);
  });

  test("returns the same env when there is no config file", () => {
    const e = new Environment(dir, Config.defaults(), null);
    expect(reloadEnv(e)).toBe(e);
  });
});
