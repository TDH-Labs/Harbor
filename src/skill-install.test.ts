import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { Config } from "./config.ts";
import { Environment } from "./env.ts";
import { install, SkillInstallError } from "./skill-install.ts";

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-sinstall-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envWithConfig(rooms: Record<string, { description: string; skills: string[] }>, defaultRoom = "general"): Environment {
  configPath = join(dir, "config.toml");
  const toml = [
    "[paths]",
    `home = "${dir}"`,
    'skills_dir = "~/.agents/skills"',
    'state_dir = "~/.agent-env"',
    "",
    "[skills]",
    `default_room = "${defaultRoom}"`,
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

/** Make a source skill directory with a SKILL.md. */
function srcSkill(name: string, description: string): string {
  const d = join(dir, "src", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return d;
}

describe("install (directory source)", () => {
  test("copies into the pool and routes to an explicit room", () => {
    const src = srcSkill("my-skill", "Does a thing");
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    const res = install(e, "my-skill", src, { room: "research" });
    expect(res.dryRun).toBe(false);
    expect(res.room).toBe("research");
    expect(existsSync(join(e.skillsDir, "my-skill", "SKILL.md"))).toBe(true);

    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.research.skills).toContain("my-skill");
    // index regenerated
    expect(existsSync(join(e.rooms, "research", "skills_index.md"))).toBe(true);
  });

  test("index write is synchronous and complete before install() returns (ordering guard)", () => {
    // Determinism regression guard (Phase-4 gate). The whole chain — config write,
    // reload, room-index regeneration — must finish SYNCHRONOUSLY before install()
    // returns. If a future change makes the index write fire-and-forget (async,
    // unawaited), these immediate, un-awaited assertions race the write and fail.
    const src = srcSkill("ordered", "Does an ordered thing");
    const e = envWithConfig({ research: { description: "Research", skills: [] } });

    const res = install(e, "ordered", src, { room: "research" });

    // install() must return a plain result, NOT a Promise — turning it async to
    // defer the write would break this (and tsc) too.
    expect(res).not.toBeInstanceOf(Promise);

    // No await, no tick: the index must already exist AND already contain the
    // freshly-routed skill's row (proving the reload-then-regenerate ran, not just
    // that an empty file was touched).
    const indexPath = join(e.rooms, "research", "skills_index.md");
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, "utf8")).toContain("| ordered |");
    // And the config write that the index depends on is already on disk.
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.research.skills).toContain("ordered");
  });

  test("auto-routes by keyword score when no room is given", () => {
    const src = srcSkill("container-deploy", "Deploy containers to a cluster");
    const e = envWithConfig({
      infra: { description: "Servers containers cluster deployment", skills: [] },
      writing: { description: "Marketing blog content", skills: [] },
    });
    const res = install(e, "container-deploy", src);
    expect(res.room).toBe("infra");
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.infra.skills).toContain("container-deploy");
  });

  test("dry-run reports source/destination/room without changing anything", () => {
    const src = srcSkill("dry-skill", "A skill");
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    const res = install(e, "dry-skill", src, { room: "research", dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.source).toBe(src);
    expect(res.installedPath).toBe(join(e.skillsDir, "dry-skill"));
    expect(res.room).toBe("research");
    // nothing happened
    expect(existsSync(join(e.skillsDir, "dry-skill"))).toBe(false);
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.research.skills).toEqual([]);
  });

  test("rejects an already-installed skill", () => {
    const src = srcSkill("dup", "A skill");
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    install(e, "dup", src, { room: "research" });
    expect(() => install(e, "dup", src, { room: "research" })).toThrow(SkillInstallError);
  });

  test("rejects a missing source and an unknown explicit room", () => {
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    expect(() => install(e, "x", join(dir, "nope"), { room: "research" })).toThrow(/does not exist/);
    const src = srcSkill("y", "A skill");
    expect(() => install(e, "y", src, { room: "ghost" })).toThrow(/not found/);
  });

  // Same room-name-flows-into-a-path/TOML-key class as skill-room-add.ts —
  // an explicit room not yet in config must be validated before the
  // room_rules.md disk probe, not just eventually rejected by a downstream
  // write.
  test("rejects a `..`-bearing unknown room name", () => {
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    const src = srcSkill("z", "A skill");
    expect(() => install(e, "z", src, { room: "../escape" })).toThrow(SkillInstallError);
    expect(() => install(e, "z", src, { room: "../escape" })).toThrow(/invalid room name/);
  });
});

describe("install (single-file source)", () => {
  test("wraps a SKILL.md file (with frontmatter) into a directory", () => {
    const file = join(dir, "loose.md");
    writeFileSync(file, "---\nname: loose\ndescription: A loose skill\n---\n\n# loose\n");
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    const res = install(e, "loose", file, { room: "research" });
    expect(existsSync(join(res.installedPath, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(res.installedPath, "SKILL.md"), "utf8")).toContain("name: loose");
  });

  test("adds minimal frontmatter when the file has none", () => {
    const file = join(dir, "raw.md");
    writeFileSync(file, "# Just a heading\n\nSome content.\n");
    const e = envWithConfig({ research: { description: "Research", skills: [] } });
    const res = install(e, "raw-skill", file, { room: "research" });
    const text = readFileSync(join(res.installedPath, "SKILL.md"), "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("name: raw-skill");
    expect(text).toContain("Just a heading");
  });
});
