import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Config,
  ConfigError,
  DEFAULT_CAPABILITIES,
  DEFAULTS,
  deepMerge,
  loadConfig,
  normalizeRoomEnv,
} from "./config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-cfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(toml: string): string {
  const p = join(dir, "config.toml");
  writeFileSync(p, toml);
  return p;
}

describe("Config.defaults", () => {
  test("exposes built-in defaults with typed accessors", () => {
    const c = Config.defaults();
    expect(c.schemaVersion).toBe("1.0");
    expect(c.homeTemplate).toBe("~");
    expect(c.skillsDirTemplate).toBe("~/.agents/skills");
    expect(c.stateDirTemplate).toBe("~/.agent-env");
    expect(c.skipDirs.has("node_modules")).toBe(true);
    expect(c.defaultSessionLimit).toBe(100_000);
    expect(c.defaultRoomDailyLimit).toBe(500_000);
  });

  test("ships no personal room names by default", () => {
    const c = Config.defaults();
    expect(Object.keys(c.roomSkills)).toHaveLength(0);
    expect(c.skillDefaultRoom).toBe("general");
  });
});

describe("Config.load", () => {
  test("missing explicit path throws ConfigError", () => {
    expect(() => Config.load(join(dir, "nope.toml"))).toThrow(ConfigError);
  });

  test("malformed TOML throws ConfigError", () => {
    const p = writeConfig("this is = = not valid toml [[[");
    expect(() => Config.load(p)).toThrow(ConfigError);
  });

  test("user values merge over defaults", () => {
    const p = writeConfig(`
[paths]
state_dir = "~/.custom-state"

[budgets]
default_session_limit = 42000
`);
    const c = Config.load(p);
    expect(c.stateDirTemplate).toBe("~/.custom-state");
    expect(c.defaultSessionLimit).toBe(42000);
    // Untouched defaults survive the merge.
    expect(c.skillsDirTemplate).toBe("~/.agents/skills");
    expect(c.defaultRoomDailyLimit).toBe(500_000);
  });

  test("a user list replaces the default list wholesale (not append)", () => {
    const p = writeConfig(`
[discovery]
skip_dirs = ["only_this"]
`);
    const c = Config.load(p);
    expect([...c.skipDirs]).toEqual(["only_this"]);
    expect(c.skipDirs.has("node_modules")).toBe(false);
  });

  test("loadConfig wrapper behaves like Config.load", () => {
    const p = writeConfig(`[paths]\nhome = "~"\n`);
    expect(loadConfig(p)).toBeInstanceOf(Config);
  });
});

describe("validation", () => {
  test("non-string paths.home is rejected", () => {
    const p = writeConfig(`[paths]\nhome = 123\n`);
    expect(() => Config.load(p)).toThrow(/paths.home must be a string/);
  });

  test("non-list discovery.skip_dirs is rejected", () => {
    const p = writeConfig(`[discovery]\nskip_dirs = "oops"\n`);
    expect(() => Config.load(p)).toThrow(/skip_dirs must be a list/);
  });

  test("a room without a skills list is rejected", () => {
    const p = writeConfig(`[skills.rooms.legal]\ndescription = "no skills key"\n`);
    expect(() => Config.load(p)).toThrow(/must define a skills list/);
  });
});

describe("room accessors", () => {
  test("roomCapabilities falls back to the baseline when unconfigured", () => {
    const p = writeConfig(`[skills.rooms.legal]\nskills = ["nda-review"]\n`);
    const c = Config.load(p);
    expect(c.roomCapabilities("legal")).toEqual([...DEFAULT_CAPABILITIES]);
    // Unknown room also gets the baseline.
    expect(c.roomCapabilities("does-not-exist")).toEqual([...DEFAULT_CAPABILITIES]);
  });

  test("roomCapabilities returns configured capabilities when present", () => {
    const p = writeConfig(`
[skills.rooms.ops]
skills = []
capabilities = ["read_skill", "schedule", "admin"]
`);
    const c = Config.load(p);
    expect(c.roomCapabilities("ops")).toEqual(["read_skill", "schedule", "admin"]);
  });

  test("roomBudget prefers room.budget, then budgets.rooms, then default", () => {
    const p = writeConfig(`
[budgets]
default_session_limit = 100000
[budgets.rooms]
research = 120000

[skills.rooms.legal]
skills = []
budget = 150000

[skills.rooms.research]
skills = []
`);
    const c = Config.load(p);
    expect(c.roomBudget("legal")).toBe(150000); // room.budget wins
    expect(c.roomBudget("research")).toBe(120000); // budgets.rooms
    expect(c.roomBudget("unknown")).toBe(100000); // default
  });

  test("roomSkillSet and roomMcpServers read room tables", () => {
    const p = writeConfig(`
[skills.rooms.legal]
skills = ["nda-review", "case-brief"]
[[skills.rooms.legal.mcp.servers]]
name = "nda-fs"
command = "filesystem"
`);
    const c = Config.load(p);
    expect(c.roomSkillSet("legal")).toEqual(new Set(["nda-review", "case-brief"]));
    expect(c.roomMcpServers("legal")).toEqual(["nda-fs"]);
    expect(c.roomSkillSet("unknown").size).toBe(0);
  });
});

describe("deepMerge", () => {
  test("merges nested tables but replaces arrays and scalars", () => {
    const base = { a: { x: 1, y: 2 }, list: [1, 2, 3], scalar: "old" };
    const merged = deepMerge(base, { a: { y: 9 }, list: [7], scalar: "new" });
    expect(merged).toEqual({ a: { x: 1, y: 9 }, list: [7], scalar: "new" });
  });

  test("does not mutate the base object", () => {
    const before = structuredClone(DEFAULTS);
    deepMerge(DEFAULTS, { paths: { home: "/tmp/elsewhere" } });
    expect(DEFAULTS).toEqual(before);
  });
});

/**
 * Each case below mirrors a REAL client behavior verified on 2026-07-23, not a
 * hypothetical. Left unnormalized, every one of these became the session's room
 * name — and an unrecognized room used to grant access to the whole skill pool.
 */
describe("normalizeRoomEnv", () => {
  test("returns null for values that carry no room information", () => {
    // genuinely unset
    expect(normalizeRoomEnv(undefined)).toBeNull();
    expect(normalizeRoomEnv(null)).toBeNull();
    // Gemini CLI substitutes an empty string for an unset variable
    expect(normalizeRoomEnv("")).toBeNull();
    expect(normalizeRoomEnv("   ")).toBeNull();
    // Goose/OpenCode never expand ${VAR}; Claude Code passes it through unset
    expect(normalizeRoomEnv("${AGENT_ENV_ROOM}")).toBeNull();
    // Cursor / VS Code syntax, unsubstituted
    expect(normalizeRoomEnv("${env:AGENT_ENV_ROOM}")).toBeNull();
    // OpenCode syntax, unsubstituted
    expect(normalizeRoomEnv("{env:AGENT_ENV_ROOM}")).toBeNull();
    // bare-dollar form
    expect(normalizeRoomEnv("$AGENT_ENV_ROOM")).toBeNull();
  });

  test("passes real room names through, trimmed", () => {
    expect(normalizeRoomEnv("legal")).toBe("legal");
    expect(normalizeRoomEnv("  devops  ")).toBe("devops");
    expect(normalizeRoomEnv("finance_real_estate")).toBe("finance_real_estate");
    expect(normalizeRoomEnv("broker-operations")).toBe("broker-operations");
  });

  test("does not swallow a legitimate name that merely contains a special character", () => {
    // Only a WHOLE-value placeholder is discarded — these are real, if odd, names
    // and silently rewriting them to the default room would be its own bug.
    expect(normalizeRoomEnv("room${x}")).toBe("room${x}");
    expect(normalizeRoomEnv("env:legal")).toBe("env:legal");
    expect(normalizeRoomEnv("$")).toBe("$");
  });
});
