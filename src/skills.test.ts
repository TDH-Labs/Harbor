import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import {
  assignCategorizedSkills,
  assignRooms,
  computeAssignments,
  explicitSkillRooms,
  generateMasterIndex,
  generateRoomIndexes,
  getAllSkillNames,
  findSkillDir,
  getSkill,
  getSkillDescription,
  listSkills,
} from "./skills.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-skills-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build an Environment rooted at the temp dir with the given skills config. */
function env(skills: Record<string, unknown> = {}): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { skills }));
  return new Environment(dir, cfg);
}

/** Create a flat-pool skill `<pool>/<name>/SKILL.md` with the given frontmatter body. */
function writeSkill(name: string, frontmatter: string, pool = join(dir, ".agents", "skills")): string {
  const skillDir = join(pool, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n`);
  return skillDir;
}

describe("getSkillDescription", () => {
  test("reads a plain quoted scalar and strips quotes", () => {
    const d = writeSkill("alpha", 'name: alpha\ndescription: "Do the alpha thing"');
    expect(getSkillDescription(d)).toBe("Do the alpha thing");
  });

  test("reads an unquoted scalar", () => {
    const d = writeSkill("beta", "name: beta\ndescription: Do the beta thing");
    expect(getSkillDescription(d)).toBe("Do the beta thing");
  });

  test("parses a YAML block scalar (|) joining indented lines with spaces", () => {
    const d = writeSkill(
      "gamma",
      "name: gamma\ndescription: |\n  First line of the description.\n  Second line continues.\nversion: 1.0",
    );
    expect(getSkillDescription(d)).toBe("First line of the description. Second line continues.");
  });

  test("parses a folded block scalar (>)", () => {
    const d = writeSkill(
      "delta",
      "name: delta\ndescription: >\n  Folded one\n  folded two",
    );
    expect(getSkillDescription(d)).toBe("Folded one folded two");
  });

  test("truncates to 100 chars with an ellipsis", () => {
    const long = "x".repeat(200);
    const d = writeSkill("eps", `name: eps\ndescription: ${long}`);
    const got = getSkillDescription(d);
    expect(got.length).toBe(100);
    expect(got.endsWith("...")).toBe(true);
  });

  test("accepts a direct SKILL.md path as well as a directory", () => {
    const d = writeSkill("zeta", "name: zeta\ndescription: Path test");
    expect(getSkillDescription(join(d, "SKILL.md"))).toBe("Path test");
  });

  test("returns empty string when no description / no file", () => {
    const d = writeSkill("eta", "name: eta");
    expect(getSkillDescription(d)).toBe("");
    expect(getSkillDescription(join(dir, "nope"))).toBe("");
  });

  test("stops at the end of frontmatter (ignores body 'description:')", () => {
    const skillDir = join(dir, ".agents", "skills", "theta");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: theta\n---\n\ndescription: this is body text not frontmatter\n",
    );
    expect(getSkillDescription(skillDir)).toBe("");
  });
});

describe("pool discovery", () => {
  test("getAllSkillNames finds flat and nested skills, sorted, deduped", () => {
    writeSkill("flat-one", "name: flat-one");
    writeSkill("flat-two", "name: flat-two");
    // nested categorized: <pool>/finance/nested-skill/SKILL.md
    writeSkill("nested-skill", "name: nested-skill", join(dir, ".agents", "skills", "finance"));
    const names = getAllSkillNames(env());
    expect(names).toContain("flat-one");
    expect(names).toContain("flat-two");
    expect(names).toContain("nested-skill");
    // sorted
    expect(names).toEqual([...names].sort());
  });

  test("empty/missing pool yields no skills", () => {
    expect(getAllSkillNames(env())).toEqual([]);
  });

  test("a category dir without its own SKILL.md is NOT a phantom skill", () => {
    const pool = join(dir, ".agents", "skills");
    // `category/` holds two real skills but has no SKILL.md of its own.
    writeSkill("real-a", "name: real-a", join(pool, "category"));
    writeSkill("real-b", "name: real-b", join(pool, "category"));
    const names = getAllSkillNames(env());
    expect(names).toContain("real-a");
    expect(names).toContain("real-b");
    expect(names).not.toContain("category"); // the container is not a skill
  });

  test("a broken/dangling symlink in the pool is not counted", () => {
    const pool = join(dir, ".agents", "skills");
    writeSkill("present", "name: present");
    mkdirSync(pool, { recursive: true });
    symlinkSync(join(dir, "does-not-exist"), join(pool, "dangling"));
    const names = getAllSkillNames(env());
    expect(names).toContain("present");
    expect(names).not.toContain("dangling");
  });
});

describe("room assignment", () => {
  test("assignRooms reverses the config room→skills lists", () => {
    const e = env({
      rooms: {
        ops: { description: "Ops", skills: ["a", "b"] },
        research: { description: "Research", skills: ["c"] },
      },
    });
    expect(assignRooms(e.config)).toEqual({ a: "ops", b: "ops", c: "research" });
  });

  test("assignCategorizedSkills maps category dirs via skill_category_to_room", () => {
    writeSkill("inv", "name: inv", join(dir, ".agents", "skills", "money"));
    const e = env({
      rooms: { books: { description: "Books", skills: [] } },
      skill_category_to_room: { money: "books" },
      default_room: "general",
    });
    expect(assignCategorizedSkills(e)).toEqual({ inv: "books" });
  });

  test("assignCategorizedSkills resolves symlinks under a configured source root", () => {
    // Real categorized source outside the pool, symlinked flat into the pool.
    const source = join(dir, "external");
    const realSkill = join(source, "infra", "deployer");
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(join(realSkill, "SKILL.md"), "---\nname: deployer\n---\n");
    const pool = join(dir, ".agents", "skills");
    mkdirSync(pool, { recursive: true });
    symlinkSync(realSkill, join(pool, "deployer"));

    const e = env({
      rooms: { devroom: { description: "Dev", skills: [] } },
      skill_category_to_room: { infra: "devroom" },
    });
    // configure the external dir as a pool source so the category can be recovered
    e.config.data.skill_pool.sources = [{ source: join(dir, "external"), into: "~/.agents/skills" }];
    expect(assignCategorizedSkills(e)).toEqual({ deployer: "devroom" });
  });

  test("computeAssignments falls unmatched skills to the default room", () => {
    writeSkill("orphan", "name: orphan");
    writeSkill("known", "name: known");
    const e = env({
      rooms: { home: { description: "Home", skills: ["known"] } },
      default_room: "home",
    });
    const { assignments, unassigned } = computeAssignments(e);
    expect(assignments.known).toBe("home");
    expect(assignments.orphan).toBe("home");
    expect(unassigned).toEqual(["orphan"]);
  });

  test("computeAssignments also returns explicitRooms, matching explicitSkillRooms(env.config)", () => {
    writeSkill("shared", "name: shared");
    const e = env({
      rooms: {
        devops: { description: "Devops", skills: ["shared"] },
        legal: { description: "Legal", skills: ["shared"] },
      },
    });
    const { explicitRooms } = computeAssignments(e);
    expect(explicitRooms).toEqual(explicitSkillRooms(e.config));
    expect(explicitRooms.shared).toEqual(["devops", "legal"]);
  });
});

describe("listSkills / getSkill", () => {
  test("listSkills returns records with room + description; filters by room", () => {
    writeSkill("aa", 'name: aa\ndescription: "Skill AA"');
    writeSkill("bb", 'name: bb\ndescription: "Skill BB"');
    const e = env({
      rooms: {
        r1: { description: "R1", skills: ["aa"] },
        r2: { description: "R2", skills: ["bb"] },
      },
      default_room: "r1",
    });
    const all = listSkills(e);
    expect(all.map((s) => s.name)).toEqual(["aa", "bb"]);
    expect(all.find((s) => s.name === "aa")).toMatchObject({ room: "r1", description: "Skill AA" });

    const r2 = listSkills(e, "r2");
    expect(r2.map((s) => s.name)).toEqual(["bb"]);
  });

  // A skill can be explicitly granted in MORE than one room (isolation.ts's
  // roomSkillAllowed already checks each room's own config list directly, so
  // this was always safe to enforce — the gap was purely in these display/
  // listing functions, which used assignRooms()'s single "last room wins"
  // pick and would make a genuinely-shared skill invisible from one of its
  // granted rooms).
  test("a skill explicitly listed in two rooms is visible from BOTH via listSkills", () => {
    writeSkill("shared", 'name: shared\ndescription: "Shared skill"');
    const e = env({
      rooms: {
        devops: { description: "Devops", skills: ["shared"] },
        legal: { description: "Legal", skills: ["shared"] },
      },
    });
    expect(listSkills(e, "devops").map((s) => s.name)).toEqual(["shared"]);
    expect(listSkills(e, "legal").map((s) => s.name)).toEqual(["shared"]);
    expect(listSkills(e, "devops").find((s) => s.name === "shared")?.rooms.sort()).toEqual([
      "devops",
      "legal",
    ]);
  });

  test("getSkill reports every explicit room, not just the primary pick", () => {
    writeSkill("shared", 'name: shared\ndescription: "Shared skill"');
    const e = env({
      rooms: {
        devops: { description: "Devops", skills: ["shared"] },
        legal: { description: "Legal", skills: ["shared"] },
      },
    });
    const detail = getSkill(e, "shared");
    expect(detail?.rooms.sort()).toEqual(["devops", "legal"]);
  });

  // computeAssignments derives `assignments` (the primary-room pick) from the
  // SAME explicitSkillRooms() array getSkill/listSkills use for `rooms`, via
  // lastRoomWins — so `room` is always literally `rooms[rooms.length - 1]`,
  // not just two independent walks that happen to agree on iteration order.
  // Unsorted on purpose: this pins the raw (config key insertion) order the
  // "last room wins" rule is documented to use.
  test("a multi-room skill's primary `room` is always the last entry of its `rooms`, by construction", () => {
    writeSkill("shared", 'name: shared\ndescription: "Shared skill"');
    const e = env({
      rooms: {
        devops: { description: "Devops", skills: ["shared"] },
        legal: { description: "Legal", skills: ["shared"] },
      },
    });
    const detail = getSkill(e, "shared")!;
    expect(detail.rooms).toEqual(["devops", "legal"]);
    expect(detail.room).toBe(detail.rooms[detail.rooms.length - 1]!);
    expect(detail.room).toBe("legal");

    const listed = listSkills(e).find((s) => s.name === "shared")!;
    expect(listed.rooms).toEqual(["devops", "legal"]);
    expect(listed.room).toBe(listed.rooms[listed.rooms.length - 1]!);
  });

  test("a single-room skill's `rooms` is just [that room]", () => {
    writeSkill("solo", 'name: solo\ndescription: "Solo skill"');
    const e = env({ rooms: { devops: { description: "Devops", skills: ["solo"] } } });
    expect(getSkill(e, "solo")?.rooms).toEqual(["devops"]);
    expect(listSkills(e).find((s) => s.name === "solo")?.rooms).toEqual(["devops"]);
  });

  test("explicitSkillRooms returns every room per skill, unaffected by config key order", () => {
    writeSkill("shared", 'name: shared\ndescription: "Shared skill"');
    const e = env({
      rooms: {
        legal: { description: "Legal", skills: ["shared"] },
        devops: { description: "Devops", skills: ["shared"] },
      },
    });
    expect(explicitSkillRooms(e.config).shared?.sort()).toEqual(["devops", "legal"]);
  });

  // Regression for the REVIEW_06.md NO-GO finding: findSkillDir/getSkill used
  // to `join(pool, name)` and trust the result without checking it stayed
  // inside the pool, so a `..`-bearing `name` walked out to an arbitrary
  // directory on disk (an arbitrary-directory-read). A skill outside the pool
  // entirely (not just outside the "flat" layer) must never be reachable.
  test("getSkill/findSkillDir refuse a `..`-escaping name outside the pool", () => {
    const secretDir = join(dir, "secret-room", "sensitive-skill");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "SKILL.md"), "---\nname: sensitive-skill\n---\n\n# secret\n");
    const e = env({ rooms: { r: { description: "R", skills: [] } } });
    expect(findSkillDir(e, "../secret-room/sensitive-skill")).toBeNull();
    expect(getSkill(e, "../secret-room/sensitive-skill")).toBeNull();
  });

  test("getSkill returns full content; null for missing", () => {
    writeSkill("cc", 'name: cc\ndescription: "Skill CC"');
    const e = env({ rooms: { r: { description: "R", skills: ["cc"] } } });
    const detail = getSkill(e, "cc");
    expect(detail).not.toBeNull();
    expect(detail!.content).toContain("# cc");
    expect(detail!.description).toBe("Skill CC");
    expect(detail!.skillMd).not.toBeNull();
    expect(getSkill(e, "missing")).toBeNull();
  });
});

describe("generateRoomIndexes", () => {
  test("writes progressive-disclosure indexes for configured rooms with skills", () => {
    writeSkill("dep", 'name: dep\ndescription: "Deploy things"');
    writeSkill("mon", 'name: mon\ndescription: "Monitor things"');
    const e = env({
      rooms: {
        ops: { description: "Operations and infra", skills: ["dep", "mon"] },
        empty: { description: "Nothing here", skills: [] },
      },
      default_room: "ops",
    });
    const res = generateRoomIndexes(e);
    expect(Object.keys(res.written)).toEqual(["ops"]); // empty room skipped
    const text = require("node:fs").readFileSync(res.written.ops, "utf8");
    expect(text).toContain("# Ops Skills Index");
    expect(text).toContain("Skills in this room: 2");
    expect(text).toContain("| dep | Deploy things |");
    expect(text).toContain("| mon | Monitor things |");
    expect(text).toContain("## How to Use Skills in This Room");
  });

  test("missing description renders the placeholder", () => {
    writeSkill("nodesc", "name: nodesc");
    const e = env({ rooms: { ops: { description: "Ops", skills: ["nodesc"] } } });
    const res = generateRoomIndexes(e);
    const text = require("node:fs").readFileSync(res.written.ops, "utf8");
    expect(text).toContain("| nodesc | (see SKILL.md for details) |");
  });
});

describe("generateMasterIndex", () => {
  test("renders one row per room with focus + count", () => {
    writeSkill("s1", "name: s1");
    const e = env({ rooms: { ops: { description: "Ops focus, more detail", skills: ["s1"] } } });
    const md = generateMasterIndex(e);
    expect(md).toContain("| ops | Ops focus | 1 |");
    expect(md).toContain("Total: 1 skills across 1 rooms.");
  });
});
