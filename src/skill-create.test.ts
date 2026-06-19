import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import {
  inferCategory,
  inferPrompt,
  nameToTags,
  scaffold,
  SkillCreateError,
} from "./skill-create.ts";

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-screate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Environment rooted at the temp dir, backed by a real config.toml file. */
function envWithConfig(rooms: Record<string, unknown> = {}): Environment {
  configPath = join(dir, "config.toml");
  const toml = [
    "[paths]",
    `home = "${dir}"`,
    'skills_dir = "~/.agents/skills"',
    'state_dir = "~/.agent-env"',
    "",
    ...Object.entries(rooms).flatMap(([name, data]: [string, any]) => [
      `[skills.rooms.${name}]`,
      `description = "${data.description ?? ""}"`,
      `skills = [${(data.skills ?? []).map((s: string) => `"${s}"`).join(", ")}]`,
      "",
    ]),
  ].join("\n");
  writeFileSync(configPath, toml);
  const cfg = Config.load(configPath);
  return new Environment(dir, cfg, configPath);
}

describe("inference helpers", () => {
  test("nameToTags splits on hyphen/underscore", () => {
    expect(nameToTags("my-cool_skill")).toBe("my, cool, skill");
  });
  test("inferCategory keys off keywords", () => {
    // "tool" would hit the productivity branch first, so use a clean dev signal.
    expect(inferCategory("deploy-helper", "Deploy via CI build")).toBe("development");
    expect(inferCategory("seo-helper", "Improve SEO content")).toBe("marketing");
    expect(inferCategory("misc", "something neutral")).toBe("productivity");
  });
  test("inferPrompt phrases a how-do-I question", () => {
    expect(inferPrompt("Reconcile the ledger.")).toBe("How do I reconcile the ledger?");
  });
});

describe("scaffold --no-register (default)", () => {
  test("creates SKILL.md + tests/ + examples/ + README.md with valid frontmatter", () => {
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    const res = scaffold(e, "test-skill", {
      workDir: join(dir, "wip"),
      description: "Do a test thing",
    });
    expect(res.registered).toBe(false);

    const skillMd = join(res.skillDir, "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(join(res.skillDir, "tests", "test_scenario.md"))).toBe(true);
    expect(existsSync(join(res.skillDir, "examples", "basic_usage.md"))).toBe(true);
    expect(existsSync(join(res.skillDir, "README.md"))).toBe(true);

    const text = readFileSync(skillMd, "utf8");
    // Frontmatter parses: split on the --- fences and parse the YAML-ish block as TOML-incompatible,
    // so just assert the structural lines are present and de-personalized.
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("name: test-skill");
    expect(text).toContain("description: Do a test thing");
    expect(text).toContain("metadata:");
    // De-personalization: no machine/system names leak into the template
    // ("acme-host" stands in for any personal machine/system name).
    expect(text).not.toContain("acme-host");
    expect(text).not.toContain("agent-env");
  });

  test("scaffolded test scenario carries RED/GREEN/REFACTOR phases", () => {
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    const res = scaffold(e, "tdd-skill", { workDir: join(dir, "wip") });
    const scenario = readFileSync(join(res.skillDir, "tests", "test_scenario.md"), "utf8");
    expect(scenario).toContain("## RED Phase");
    expect(scenario).toContain("## GREEN Phase");
    expect(scenario).toContain("## REFACTOR Phase");
  });

  test("does not touch config or the pool when not registering", () => {
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    scaffold(e, "loner", { workDir: join(dir, "wip") });
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.research.skills).toEqual([]);
    expect(existsSync(join(e.skillsDir, "loner"))).toBe(false);
  });

  test("refuses to overwrite an existing directory", () => {
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    scaffold(e, "dupe", { workDir: join(dir, "wip") });
    expect(() => scaffold(e, "dupe", { workDir: join(dir, "wip") })).toThrow(SkillCreateError);
  });
});

describe("scaffold --register", () => {
  test("copies into the pool, routes to the room, regenerates the index", () => {
    const e = envWithConfig({ research: { description: "Research room", skills: [] } });
    const res = scaffold(e, "live-skill", {
      workDir: join(dir, "wip"),
      room: "research",
      register: true,
      description: "A live registered skill",
    });
    expect(res.registered).toBe(true);

    // pool copy exists
    expect(existsSync(join(e.skillsDir, "live-skill", "SKILL.md"))).toBe(true);
    // routed in config
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.research.skills).toContain("live-skill");
    // index regenerated
    const index = join(e.rooms, "research", "skills_index.md");
    expect(existsSync(index)).toBe(true);
    expect(readFileSync(index, "utf8")).toContain("live-skill");
  });

  test("registration requires an existing room", () => {
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    expect(() =>
      scaffold(e, "x", { workDir: join(dir, "wip"), room: "ghost", register: true }),
    ).toThrow(SkillCreateError);
    expect(() =>
      scaffold(e, "y", { workDir: join(dir, "wip"), register: true }),
    ).toThrow(/requires a --room/);
  });
});
