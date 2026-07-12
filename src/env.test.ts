import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULT_CONFIG_PATH, fileExists } from "./config.ts";
import { Environment } from "./env.ts";

describe("Environment.resolve", () => {
  const env = new Environment("/srv/root", Config.defaults());

  test('"~" resolves to the root', () => {
    expect(env.resolve("~")).toBe("/srv/root");
  });
  test('"~/x" resolves under the root', () => {
    expect(env.resolve("~/.agents/skills")).toBe("/srv/root/.agents/skills");
  });
  test("absolute templates are used as-is", () => {
    expect(env.resolve("/etc/harbor")).toBe("/etc/harbor");
  });
  test("bare relative templates join to the root", () => {
    expect(env.resolve("data/legal")).toBe("/srv/root/data/legal");
  });
});

describe("derived paths", () => {
  const env = new Environment("/srv/root", Config.defaults());

  test("standard layout paths derive from the root", () => {
    expect(env.stateDir).toBe("/srv/root/.agent-env");
    expect(env.skillsDir).toBe("/srv/root/.agents/skills");
    expect(env.workspace).toBe("/srv/root/workspace");
    expect(env.rooms).toBe("/srv/root/rooms");
    expect(env.agentMap).toBe("/srv/root/agent_map.md");
  });

  test("all four state DB paths live under the state dir", () => {
    expect(env.schedulerDb).toBe("/srv/root/.agent-env/scheduler.db");
    expect(env.compactionDb).toBe("/srv/root/.agent-env/compaction.db");
    expect(env.isolationDb).toBe("/srv/root/.agent-env/isolation.db");
    expect(env.sessionsDb).toBe("/srv/root/.agent-env/sessions.db");
    expect(env.sessionsDir).toBe("/srv/root/.agent-env/sessions");
  });

  test("state dir follows a custom config template", () => {
    const cfg = new Config({
      ...Config.defaults().data,
      paths: { home: "~", skills_dir: "~/skills", state_dir: "/var/harbor" },
    });
    const e = new Environment("/srv/root", cfg);
    expect(e.stateDir).toBe("/var/harbor");
    expect(e.schedulerDb).toBe("/var/harbor/scheduler.db");
    expect(e.skillsDir).toBe("/srv/root/skills");
  });
});

describe("Environment.load", () => {
  test("derives the root from os.homedir() for the default home template", () => {
    const e = Environment.load(Config.defaults());
    expect(e.root).toBe(homedir());
    expect(e.skillsDir).toBe(join(homedir(), ".agents", "skills"));
  });

  test("an explicit root override wins over the home template", () => {
    const e = Environment.load(Config.defaults(), "/explicit/root");
    expect(e.root).toBe("/explicit/root");
  });

  test("loading from a Config instance leaves configPath null", () => {
    const e = Environment.load(Config.defaults());
    expect(e.configPath).toBeNull();
  });

  // Regression for a real bug: Config.load(null) silently falls back to
  // DEFAULT_CONFIG_PATH when it exists, and read-path commands (skills-list,
  // sync, ...) worked fine off that fallback — but Environment.load() used
  // to leave configPath null in this exact case regardless, so every
  // write-path command (skill-room-add, ensureRoomInConfig, ...) refused
  // with "environment built from defaults" even though a real config file
  // had just been loaded from. Can't safely test the "a default config
  // exists" branch through a temp dir — DEFAULT_CONFIG_PATH resolves once
  // from the real os.homedir() at module-load time, not injectable — so this
  // asserts the invariant the fix establishes (both code paths agree on
  // whether the default file is in play) rather than one hardcoded outcome,
  // which holds regardless of the state of the machine running the test.
  test("configPath tracks the same DEFAULT_CONFIG_PATH fallback Config.load(null) itself uses", () => {
    const e = Environment.load();
    if (fileExists(DEFAULT_CONFIG_PATH)) {
      expect(e.configPath).toBe(DEFAULT_CONFIG_PATH);
    } else {
      expect(e.configPath).toBeNull();
    }
  });

  describe("an explicit --config path", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "harbor-env-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("wins over the DEFAULT_CONFIG_PATH fallback, whether or not a default config exists", () => {
      const explicitPath = join(dir, "explicit-config.toml");
      writeFileSync(explicitPath, `[paths]\nhome = "${dir}"\n`);
      const e = Environment.load(explicitPath);
      expect(e.configPath).toBe(explicitPath);
      expect(e.configPath).not.toBe(DEFAULT_CONFIG_PATH);
    });
  });

  test("watchPaths resolves every template against the root", () => {
    const e = Environment.load(Config.defaults(), "/srv/root");
    expect(e.watchPaths()).toContain("/srv/root/agent_map.md");
    expect(e.watchPaths()).toContain("/srv/root/.agents/skills");
  });
});
