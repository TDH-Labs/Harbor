import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { Config } from "./config.ts";
import { Environment } from "./env.ts";
import { computeAssignments } from "./skills.ts";
import {
  assignOrphans,
  deriveRoomSignals,
  getOrphanSkills,
  scoreSkillForRooms,
} from "./skill-assign.ts";

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-sassign-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSkill(name: string, description: string): void {
  const skillDir = join(dir, ".agents", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

/** Environment with a real config.toml so assignments can be written back. */
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

describe("deriveRoomSignals / scoreSkillForRooms (config-driven, no hardcoded rooms)", () => {
  test("a room's name, skills, and description become weighted keywords", () => {
    const e = envWithConfig({
      deployment: { description: "Container orchestration and pipelines", skills: ["docker-build"] },
    });
    const signals = deriveRoomSignals(e.config);
    const dep = signals.deployment!;
    expect(dep.get("deployment")).toBe(4); // room name → weight 4
    expect(dep.get("docker")).toBe(4); // skill-name token → 4
    expect(dep.get("container")).toBe(2); // description token → 2
  });

  test("scores a skill toward the room whose keywords it shares", () => {
    const e = envWithConfig({
      writing: { description: "Blog and content marketing copy", skills: ["seo-audit"] },
      infra: { description: "Servers, containers, deployment pipelines", skills: ["docker-build"] },
    });
    const signals = deriveRoomSignals(e.config);
    const scores = scoreSkillForRooms("container-deploy", "Deploy containers to servers", signals);
    expect(scores[0]!.room).toBe("infra");
  });
});

describe("getOrphanSkills", () => {
  test("returns only skills assigned to no room, with scores", () => {
    writeSkill("docker-build", "Build container images");
    writeSkill("loose-skill", "Deploy servers and containers");
    const e = envWithConfig({
      infra: { description: "Servers and containers", skills: ["docker-build"] },
    });
    const orphans = getOrphanSkills(e);
    expect(orphans.map((o) => o.name)).toEqual(["loose-skill"]);
    expect(orphans[0]!.scores[0]!.room).toBe("infra");
  });

  test("zero orphans when every pool skill is assigned", () => {
    writeSkill("docker-build", "Build images");
    const e = envWithConfig({ infra: { description: "Infra", skills: ["docker-build"] } });
    expect(getOrphanSkills(e)).toEqual([]);
  });
});

describe("assignOrphans", () => {
  test("report mode writes nothing", () => {
    writeSkill("orphan", "Deploy containers");
    const e = envWithConfig({ infra: { description: "Containers", skills: [] } });
    const res = assignOrphans(e, "report");
    expect(res.assigned).toEqual({});
    expect(res.orphans.map((o) => o.name)).toEqual(["orphan"]);
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.infra.skills).toEqual([]);
  });

  test("auto mode assigns each orphan to its best room and writes config", () => {
    writeSkill("container-skill", "Deploy containers to a cluster");
    writeSkill("copy-skill", "Write marketing blog content");
    const e = envWithConfig({
      infra: { description: "Servers containers cluster deployment", skills: [] },
      writing: { description: "Marketing blog content copy", skills: [] },
    });
    const res = assignOrphans(e, "auto");
    expect(res.assigned["container-skill"]).toBe("infra");
    expect(res.assigned["copy-skill"]).toBe("writing");
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.infra.skills).toContain("container-skill");
    expect(cfg.skills.rooms.writing.skills).toContain("copy-skill");
  });

  test("auto mode leaves zero orphans afterward (acceptance criterion)", () => {
    writeSkill("aaa", "Deploy containers");
    writeSkill("bbb", "Unmatchable zzzzz qqqqq"); // no keyword overlap → default room
    const e = envWithConfig(
      { infra: { description: "Containers deployment", skills: [] }, general: { description: "Catch all", skills: [] } },
      "general",
    );
    assignOrphans(e, "auto");
    // reload to see the written assignments
    const reloaded = new Environment(dir, Config.load(configPath), configPath);
    expect(getOrphanSkills(reloaded)).toEqual([]);
    expect(computeAssignments(reloaded).unassigned).toEqual([]);
  });

  test("room mode assigns all orphans to one room", () => {
    writeSkill("one", "anything");
    writeSkill("two", "whatever");
    const e = envWithConfig({ catchall: { description: "Everything", skills: [] } });
    const res = assignOrphans(e, "room", { room: "catchall" });
    expect(res.assigned).toEqual({ one: "catchall", two: "catchall" });
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    expect(cfg.skills.rooms.catchall.skills.sort()).toEqual(["one", "two"]);
  });

  test("room mode rejects an unknown room", () => {
    writeSkill("one", "anything");
    const e = envWithConfig({ catchall: { description: "Everything", skills: [] } });
    expect(() => assignOrphans(e, "room", { room: "ghost" })).toThrow(/not found/);
  });

  // Same room-name-flows-into-a-path/TOML-key class as skill-install.ts and
  // skill-room-add.ts: a `..`-bearing room must be rejected before the
  // existsSync(join(env.rooms, room, "room_rules.md")) disk probe, not left
  // to eventually fail (or not) downstream.
  test("room mode rejects a `..`-bearing room name before probing disk", () => {
    writeSkill("one", "anything");
    const e = envWithConfig({ catchall: { description: "Everything", skills: [] } });
    expect(() => assignOrphans(e, "room", { room: "../escape" })).toThrow(/invalid room name/);
  });
});
