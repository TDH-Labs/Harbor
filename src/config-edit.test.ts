import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { Config } from "./config.ts";
import { Environment } from "./env.ts";
import {
  addMcpServerToRoom,
  addSkillToRoom,
  ConfigEditError,
  ensureRoomInConfig,
  isValidRoomName,
  reloadEnv,
  removeSkillFromRoom,
  setSkillSubdomains,
  validateRoomName,
} from "./config-edit.ts";

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

describe("isValidRoomName / validateRoomName", () => {
  test("accepts simple slugs", () => {
    expect(isValidRoomName("ops")).toBe(true);
    expect(isValidRoomName("legal-2")).toBe(true);
    expect(isValidRoomName("dev_ops")).toBe(true);
  });

  // A room name becomes both a directory segment and a TOML section key —
  // `..` or `/` in either position is the same escape class isolation.ts
  // was hardened against.
  test("rejects `..` segments and path separators", () => {
    expect(isValidRoomName("..")).toBe(false);
    expect(isValidRoomName("../finance")).toBe(false);
    expect(isValidRoomName("ops/../finance")).toBe(false);
    expect(isValidRoomName("a/b")).toBe(false);
    expect(isValidRoomName("")).toBe(false);
  });

  test("validateRoomName throws ConfigEditError for an invalid name, is silent for a valid one", () => {
    expect(() => validateRoomName("../finance")).toThrow(ConfigEditError);
    expect(() => validateRoomName("ops")).not.toThrow();
  });
});

describe("addSkillToRoom", () => {
  test("rejects a `..`-bearing room name before touching config", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    expect(() => addSkillToRoom(e, "x", "../escape")).toThrow(ConfigEditError);
  });

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

describe("addMcpServerToRoom", () => {
  test("rejects a `..`-bearing room name before touching config", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    expect(() => addMcpServerToRoom(e, "../escape", { name: "x", command: "echo" })).toThrow(ConfigEditError);
  });

  test("appends a server to a room with no mcp table yet, round-trips through smol-toml", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    const res = addMcpServerToRoom(e, "ops", {
      name: "agentphone",
      command: "npx",
      args: ["-y", "agentphone-mcp"],
      env: { API_KEY: "abc" },
    });
    expect(res.changed).toBe(true);
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    const servers = cfg.skills.rooms.ops.mcp.servers;
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      name: "agentphone",
      command: "npx",
      args: ["-y", "agentphone-mcp"],
      env: { API_KEY: "abc" },
    });
  });

  test("appends alongside an existing server, without disturbing it", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    addMcpServerToRoom(e, "ops", { name: "first", command: "echo" });
    const res = addMcpServerToRoom(e, "ops", { name: "second", command: "bun" });
    expect(res.changed).toBe(true);
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    const names = cfg.skills.rooms.ops.mcp.servers.map((s: any) => s.name);
    expect(names).toEqual(["first", "second"]);
  });

  test("is idempotent — re-adding a byte-identical entry is a no-op", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    addMcpServerToRoom(e, "ops", { name: "agentphone", command: "npx", args: ["-y"] });
    const res = addMcpServerToRoom(e, "ops", { name: "agentphone", command: "npx", args: ["-y"] });
    expect(res.changed).toBe(false);
  });

  test("upserts — a same-name entry with a different definition replaces it in place", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    addMcpServerToRoom(e, "ops", { name: "agentphone", command: "npx", args: ["-y"] });
    const res = addMcpServerToRoom(e, "ops", { name: "agentphone", command: "npx", args: ["-y", "--verbose"] });
    expect(res.changed).toBe(true);
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    const servers = cfg.skills.rooms.ops.mcp.servers;
    expect(servers).toHaveLength(1); // replaced, not duplicated
    expect(servers[0].args).toEqual(["-y", "--verbose"]);
  });

  test("throws for an unknown room", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    expect(() => addMcpServerToRoom(e, "ghost", { name: "x", command: "echo" })).toThrow(ConfigEditError);
  });

  test("throws when the environment has no config file", () => {
    const e = new Environment(dir, Config.defaults(), null);
    expect(() => addMcpServerToRoom(e, "ops", { name: "x", command: "echo" })).toThrow(/no config file/);
  });
});

describe("removeSkillFromRoom", () => {
  test("rejects a `..`-bearing room name before touching config", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    expect(() => removeSkillFromRoom(e, "existing", "../escape")).toThrow(ConfigEditError);
  });

  test("removes a skill from a populated list, leaves the rest untouched", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    addSkillToRoom(e, "second", "ops");
    const res = removeSkillFromRoom(e, "existing", "ops");
    expect(res.changed).toBe(true);
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.ops.skills).toEqual(["second"]);
  });

  test("is idempotent — removing a skill not in the list is a no-op", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    const res = removeSkillFromRoom(e, "not-there", "ops");
    expect(res.changed).toBe(false);
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.ops.skills).toEqual(["existing"]);
  });

  test("throws for an unknown room", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    expect(() => removeSkillFromRoom(e, "existing", "ghost")).toThrow(ConfigEditError);
  });

  test("throws when the environment has no config file", () => {
    const e = new Environment(dir, Config.defaults(), null);
    expect(() => removeSkillFromRoom(e, "existing", "ops")).toThrow(/no config file/);
  });
});

describe("setSkillSubdomains", () => {
  test("merges hints into [skills.skill_subdomain] and reloads", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    const res = setSkillSubdomains(e, { existing: "ops/runbooks", other: "ops/oncall" });
    expect(res.changed).toBe(true);
    const data = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(data.skills.skill_subdomain).toEqual({ existing: "ops/runbooks", other: "ops/oncall" });
    expect(reloadEnv(e).config.skillSubdomains.existing).toBe("ops/runbooks");
  });

  test("is idempotent — re-applying the same map does not rewrite", () => {
    const e = writeConfig(BASE.replace("PLACEHOLDER", dir));
    setSkillSubdomains(e, { existing: "ops/runbooks" });
    const again = setSkillSubdomains(reloadEnv(e), { existing: "ops/runbooks" });
    expect(again.changed).toBe(false);
  });

  test("throws without a config file", () => {
    const e = new Environment(dir, Config.defaults(), null);
    expect(() => setSkillSubdomains(e, { a: "b" })).toThrow(/no config file/);
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
