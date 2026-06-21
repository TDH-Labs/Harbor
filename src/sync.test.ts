import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import {
  SYNC_STAMP,
  discoverAll,
  discoverRooms,
  discoverWorkspaceProjects,
  ensureWorkspaceDir,
  fullSync,
  generateHomeAgentsMd,
  generateProjectAgentsMd,
  generateRoomIndex,
  isProjectDir,
  mergeRoomsIntoMap,
  parseProjectTable,
  parseRoomTable,
  parseTable,
  runGenerate,
  writeIfChanged,
} from "./sync.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-sync-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(rooms: Record<string, unknown> = {}): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { skills: { rooms } }));
  return new Environment(dir, cfg);
}

const SAMPLE_MAP = `# Map

## Rooms

| Room | Path | Purpose |
|------|------|---------|
| legal | ~/rooms/legal | Legal work |
| devops | ~/rooms/devops | Infra |

## Projects

| Project | Path | Status |
|---------|------|--------|
| harbor | ~/workspace/harbor | Active |
`;

describe("markdown table parsing", () => {
  test("parseTable keys cells by header and skips the separator row", () => {
    const rows = parseTable(SAMPLE_MAP.split("\n"));
    expect(rows[0]).toEqual({ Room: "legal", Path: "~/rooms/legal", Purpose: "Legal work" });
    expect(rows).toHaveLength(2);
  });

  test("parseRoomTable / parseProjectTable pick the right table", () => {
    expect(parseRoomTable(SAMPLE_MAP).map((r) => r["Room"])).toEqual(["legal", "devops"]);
    const projects = parseProjectTable(SAMPLE_MAP);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.["Project"]).toBe("harbor");
  });

  test("a Workspace column is rendered as a Path alias when generating beacons", () => {
    // Detection requires a "Path" header (Python parity); the alias applies when
    // rendering a parsed row's value: `Path ?? Workspace`.
    const row = { Project: "x", Workspace: "~/workspace/x", Status: "Active" };
    const out = generateHomeAgentsMd(env(), [], [row]);
    expect(out).toContain("| x | ~/workspace/x | Active |");
  });
});

describe("beacon generation", () => {
  test("home AGENTS.md ends with the exact sync stamp and lists rooms/projects", () => {
    const out = generateHomeAgentsMd(env(), parseRoomTable(SAMPLE_MAP), parseProjectTable(SAMPLE_MAP));
    expect(out.trimEnd().endsWith(SYNC_STAMP)).toBe(true);
    expect(out).toContain("| legal | ~/rooms/legal | Legal work |");
    expect(out).toContain("| harbor | ~/workspace/harbor | Active |");
  });

  test("project AGENTS.md is a stub WITHOUT the sync stamp", () => {
    const out = generateProjectAgentsMd(env(), "myproj");
    expect(out).toContain("# myproj");
    expect(out).not.toContain(SYNC_STAMP);
  });

  test("room index lists configured skills sorted", () => {
    const e = env({ legal: { skills: ["nda-review", "case-brief"] } });
    const idx = generateRoomIndex(e, "legal");
    expect(idx.indexOf("case-brief")).toBeLessThan(idx.indexOf("nda-review"));
  });
});

describe("discovery", () => {
  test("isProjectDir requires a signature and rejects dotdirs / skip_dirs", () => {
    const e = env();
    mkdirSync(join(dir, "proj", ".git"), { recursive: true });
    mkdirSync(join(dir, "plain"), { recursive: true });
    mkdirSync(join(dir, ".hidden", ".git"), { recursive: true });
    mkdirSync(join(dir, "node_modules", ".git"), { recursive: true }); // in skip_dirs
    expect(isProjectDir(e, join(dir, "proj"))).toBe(true);
    expect(isProjectDir(e, join(dir, "plain"))).toBe(false);
    expect(isProjectDir(e, join(dir, ".hidden"))).toBe(false);
    expect(isProjectDir(e, join(dir, "node_modules"))).toBe(false);
  });

  test("discoverWorkspaceProjects returns any immediate workspace subdir", () => {
    mkdirSync(join(dir, "workspace", "a"), { recursive: true });
    mkdirSync(join(dir, "workspace", "b"), { recursive: true });
    const found = discoverWorkspaceProjects(env()).map((p) => p.split("/").pop());
    expect(found).toEqual(["a", "b"]);
  });

  test("discoverAll dedups home projects already present in workspace", () => {
    mkdirSync(join(dir, "workspace", "dup"), { recursive: true });
    mkdirSync(join(dir, "dup", ".git"), { recursive: true }); // home project, same name
    mkdirSync(join(dir, "solo", ".git"), { recursive: true });
    const names = discoverAll(env()).map((p) => p.split("/").pop()).sort();
    expect(names).toEqual(["dup", "solo"]);
  });
});

describe("runGenerate (--generate-only path)", () => {
  test("writes home beacons with the stamp and is idempotent", () => {
    writeFileSync(join(dir, "agent_map.md"), SAMPLE_MAP);
    const first = runGenerate(env());
    const agentsPath = join(dir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);
    expect(readFileSync(agentsPath, "utf8")).toContain(SYNC_STAMP);
    expect(first.written[agentsPath]).toBe(true);

    // Second run: content identical → not rewritten.
    const second = runGenerate(env());
    expect(second.written[agentsPath]).toBe(false);
  });

  test("works with no agent_map.md present (empty tables, still stamped)", () => {
    const res = runGenerate(env());
    expect(res.written[join(dir, "AGENTS.md")]).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(SYNC_STAMP);
  });

  test("writes a room skills_index.md per configured room", () => {
    const e = env({ legal: { skills: ["nda-review"] } });
    runGenerate(e);
    expect(existsSync(join(dir, "rooms", "legal", "skills_index.md"))).toBe(true);
  });

  test("does NOT discover or scaffold workspace projects (watcher-contamination guard)", () => {
    // This is the exact boundary that keeps `--generate-only` from touching the
    // watched workspace: it regenerates home beacons ONLY. An existing workspace
    // project dir must come out untouched — no compaction stubs, no AGENTS.md
    // symlink. If runGenerate ever starts scaffolding, the watcher would see new
    // files appear and storm. Contrast: fullSync (below) DOES scaffold.
    const proj = join(dir, "workspace", "live-proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(dir, "agent_map.md"), SAMPLE_MAP);

    runGenerate(env());

    // Home beacon was generated...
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    // ...but the workspace project was NOT scaffolded.
    for (const f of ["research.md", "plan.md", "scratchpad.md", "AGENTS.md"]) {
      expect(existsSync(join(proj, f))).toBe(false);
    }

    // Contrast: fullSync DOES scaffold the same project (proves the guard is real,
    // not just that scaffolding is broken everywhere).
    fullSync(env());
    for (const f of ["research.md", "plan.md", "scratchpad.md"]) {
      expect(existsSync(join(proj, f))).toBe(true);
    }
    expect(readlinkSync(join(proj, "AGENTS.md"))).toBe(join(dir, "AGENTS.md"));
  });
});

describe("ensureWorkspaceDir / fullSync", () => {
  test("scaffolds compaction stubs and an AGENTS.md symlink to the home beacon", () => {
    runGenerate(env()); // create the home AGENTS.md target first
    const proj = join(dir, "workspace", "demo");
    ensureWorkspaceDir(env(), proj);
    for (const f of ["research.md", "plan.md", "scratchpad.md"]) {
      expect(existsSync(join(proj, f))).toBe(true);
    }
    expect(readlinkSync(join(proj, "AGENTS.md"))).toBe(join(dir, "AGENTS.md"));
  });

  test("fullSync discovers workspace projects and scaffolds each", () => {
    mkdirSync(join(dir, "workspace", "one"), { recursive: true });
    const res = fullSync(env());
    expect(res.projects.map((p) => p.split("/").pop())).toEqual(["one"]);
    expect(existsSync(join(dir, "workspace", "one", "plan.md"))).toBe(true);
  });
});

describe("writeIfChanged", () => {
  test("returns true on first write, false when unchanged", () => {
    const p = join(dir, "x.txt");
    expect(writeIfChanged(p, "hello")).toBe(true);
    expect(writeIfChanged(p, "hello")).toBe(false);
    expect(writeIfChanged(p, "world")).toBe(true);
  });
});

describe("discoverRooms", () => {
  test("returns sorted room names that contain room_rules.md", () => {
    mkdirSync(join(dir, "rooms", "devops"), { recursive: true });
    mkdirSync(join(dir, "rooms", "legal"), { recursive: true });
    mkdirSync(join(dir, "rooms", "empty"), { recursive: true }); // no room_rules.md
    writeFileSync(join(dir, "rooms", "devops", "room_rules.md"), "# DevOps");
    writeFileSync(join(dir, "rooms", "legal", "room_rules.md"), "# Legal");
    expect(discoverRooms(env())).toEqual(["devops", "legal"]);
  });

  test("returns [] when rooms dir is absent", () => {
    expect(discoverRooms(env())).toEqual([]);
  });
});

describe("mergeRoomsIntoMap", () => {
  test("adds rooms not yet in the table", () => {
    const result = mergeRoomsIntoMap(SAMPLE_MAP, ["legal", "devops", "research"]);
    const rows = parseRoomTable(result);
    expect(rows.map((r) => r["Room"])).toContain("research");
    expect(rows.find((r) => r["Room"] === "research")?.["Path"]).toBe("~/rooms/research/");
    expect(rows).toHaveLength(3);
  });

  test("returns original string unchanged when all rooms already present", () => {
    const result = mergeRoomsIntoMap(SAMPLE_MAP, ["legal", "devops"]);
    expect(result).toBe(SAMPLE_MAP);
  });

  test("matches by dir name — backtick-wrapped paths are not duplicated", () => {
    const map = SAMPLE_MAP.replace("~/rooms/legal", "`~/rooms/legal/`");
    const result = mergeRoomsIntoMap(map, ["legal", "marketing"]);
    const rows = parseRoomTable(result);
    const names = rows.map((r) => r["Room"]);
    expect(names.filter((n) => n === "legal")).toHaveLength(1); // no duplicate
    expect(names).toContain("marketing");
  });
});

describe("fullSync room discovery", () => {
  test("merges filesystem rooms into agent_map.md on sync", () => {
    const map = join(dir, "agent_map.md");
    writeFileSync(map, SAMPLE_MAP);
    mkdirSync(join(dir, "rooms", "research"), { recursive: true });
    writeFileSync(join(dir, "rooms", "research", "room_rules.md"), "# Research");
    fullSync(env());
    const rows = parseRoomTable(readFileSync(map, "utf8"));
    expect(rows.map((r) => r["Room"])).toContain("research");
  });

  test("does not duplicate existing rooms on repeated sync", () => {
    const map = join(dir, "agent_map.md");
    writeFileSync(map, SAMPLE_MAP);
    mkdirSync(join(dir, "rooms", "legal"), { recursive: true });
    writeFileSync(join(dir, "rooms", "legal", "room_rules.md"), "# Legal");
    fullSync(env());
    fullSync(env()); // idempotent
    const rows = parseRoomTable(readFileSync(map, "utf8"));
    expect(rows.filter((r) => r["Room"] === "legal")).toHaveLength(1);
  });
});
