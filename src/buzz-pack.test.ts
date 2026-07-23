/**
 * buzz-pack.test.ts — Buzz Persona Pack emission.
 *
 * Every assertion here is pinned to the REAL deserializer in block/buzz
 * (@6a56c8bd, `crates/buzz-persona/src/*.rs`), not the spec prose — the two
 * disagree, and the code is what parses. Soak-safe: pool + config live under a
 * mkdtemp root; no test reads the live machine.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import {
  BuzzPackError,
  PERSONA_FIELDS,
  descriptionFor,
  displayNameFor,
  findSensitive,
  personaBody,
  personaNameFor,
  planPack,
  renderManifest,
  renderPersona,
  writePack,
} from "./buzz-pack.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-buzz-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(rooms: Record<string, unknown>): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { skills_dir: join(dir, "pool") }, skills: { rooms } }));
  return new Environment(dir, cfg);
}

function writeSkill(name: string): void {
  const d = join(dir, "pool", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`);
}

describe("persona naming", () => {
  test("accepts Harbor room names including underscores", () => {
    expect(personaNameFor("finance_real_estate")).toBe("finance_real_estate");
    expect(personaNameFor("broker-operations")).toBe("broker-operations");
  });

  test("rejects a room name Buzz's validator would refuse", () => {
    // validate.rs enforces [a-zA-Z0-9_-]+, max 64.
    expect(() => personaNameFor("has space")).toThrow(BuzzPackError);
    expect(() => personaNameFor("has.dot")).toThrow(BuzzPackError);
    expect(() => personaNameFor("x".repeat(65))).toThrow(BuzzPackError);
  });

  test("display name is humanized from the room slug", () => {
    expect(displayNameFor("finance_real_estate")).toBe("Finance Real Estate");
    expect(displayNameFor("devops")).toBe("Devops");
  });
});

// `description` is REQUIRED and must be non-empty after trim, and several real
// Harbor rooms carry an empty one — emitting blank fails the whole pack.
describe("description is never emitted empty", () => {
  test("synthesizes one when the room has no description", () => {
    const d = descriptionFor("bookkeeping", "", 11);
    expect(d.trim().length).toBeGreaterThan(0);
    expect(d).toContain("bookkeeping");
    expect(d).toContain("11 skills");
  });

  test("singularizes correctly and keeps a configured description verbatim", () => {
    expect(descriptionFor("gaming", "", 1)).toContain("1 skill ");   // singular, not "1 skills"
    expect(descriptionFor("gaming", "", 1)).not.toContain("1 skills");
    expect(descriptionFor("legal", "Legal practice", 110)).toBe("Legal practice");
  });
});

describe("planPack", () => {
  test("maps one room to one persona with its skills and channel", () => {
    writeSkill("nda-review");
    writeSkill("case-brief");
    const plan = planPack(env({ legal: { description: "Legal work", skills: ["nda-review", "case-brief"] } }));
    expect(plan.personas).toHaveLength(1);
    const p = plan.personas[0]!;
    expect(p.name).toBe("legal");
    expect(p.description).toBe("Legal work");
    expect(p.skills).toEqual(["./skills/case-brief/", "./skills/nda-review/"]);
    expect(p.subscribe).toEqual(["#legal"]);
    expect(plan.skillsToCopy).toEqual(["case-brief", "nda-review"]);
  });

  test("reports a skill named by a room but absent from the pool", () => {
    writeSkill("present");
    const plan = planPack(env({ ops: { description: "Ops", skills: ["present", "ghost"] } }));
    expect(plan.missingSkills).toEqual([{ room: "ops", skill: "ghost" }]);
    // ...and does NOT reference it, which would break the pack.
    expect(plan.personas[0]!.skills).toEqual(["./skills/present/"]);
  });

  // Buzz drops a command-less MCP server SILENTLY. Surfacing it here is the
  // whole reason the plan carries droppedServers.
  test("drops a non-stdio MCP server and says why", () => {
    const plan = planPack(
      env({
        room1: {
          description: "R",
          skills: [],
          mcp: { servers: [{ name: "http-only", url: "https://example.com/mcp" }, { name: "ok", command: "x" }] },
        },
      }),
    );
    expect(plan.droppedServers).toHaveLength(1);
    expect(plan.droppedServers[0]!.server).toBe("http-only");
    expect(plan.droppedServers[0]!.reason).toContain("stdio-only");
    expect(plan.personas[0]!.mcp_servers.map((s) => s.name)).toEqual(["ok"]);
  });

  test("throws for an unknown room and for an empty environment", () => {
    expect(() => planPack(env({ a: { skills: [] } }), { room: "nope" })).toThrow(BuzzPackError);
    expect(() => planPack(env({}))).toThrow(/no rooms configured/);
  });
});

// The single highest-risk trap: frontmatter is `deny_unknown_fields`, so ONE
// stray key fails the entire pack at parse time.
describe("renderPersona emits only fields the deserializer accepts", () => {
  test("every top-level frontmatter key is in the allowed set", () => {
    writeSkill("s1");
    const plan = planPack(
      env({
        ops: {
          description: "Ops",
          skills: ["s1"],
          mcp: { servers: [{ name: "srv", command: "cmd", args: ["--x"], env: { K: "V" } }] },
        },
      }),
    );
    const md = renderPersona(plan.personas[0]!, personaBody(plan.personas[0]!));
    const fm = md.split("---")[1]!;
    const topKeys = fm
      .split("\n")
      .filter((l) => /^[a-z_]+:/.test(l))
      .map((l) => l.split(":")[0]!);
    expect(topKeys.length).toBeGreaterThan(0);
    for (const k of topKeys) expect(PERSONA_FIELDS).toContain(k as (typeof PERSONA_FIELDS)[number]);
  });

  test("mcp env renders as an OBJECT, never the ACP-wire [{name,value}] array", () => {
    const plan = planPack(
      env({ ops: { description: "O", skills: [], mcp: { servers: [{ name: "s", command: "c", env: { A: "1" } }] } } }),
    );
    const md = renderPersona(plan.personas[0]!, "body");
    expect(md).toContain("env:");
    expect(md).toContain('A: "1"');
    // the wire form must not leak into a pack file
    expect(md).not.toContain("- name: A");
    expect(md).not.toContain("value:");
  });

  test("frontmatter is delimited so the closing --- is on its own line", () => {
    const plan = planPack(env({ ops: { description: "O", skills: [] } }));
    const md = renderPersona(plan.personas[0]!, "body text");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("\n---\n");
    expect(md.trimEnd().endsWith("body text")).toBe(true);
  });
});

describe("writePack", () => {
  test("writes the layout the loader requires and copies skills", () => {
    writeSkill("s1");
    writeSkill("s2");
    const e = env({ ops: { description: "Ops", skills: ["s1"] }, res: { description: "Res", skills: ["s2"] } });
    const out = join(dir, "pack");
    const res = writePack(e, planPack(e), out);

    // .plugin/plugin.json is the ONLY hardcoded path in the loader.
    expect(existsSync(join(out, ".plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(out, "agents", "ops.persona.md"))).toBe(true);
    expect(existsSync(join(out, "agents", "res.persona.md"))).toBe(true);
    expect(existsSync(join(out, "skills", "s1", "SKILL.md"))).toBe(true);
    expect(res.skillsCopied).toBe(2);

    const manifest = JSON.parse(readFileSync(join(out, ".plugin", "plugin.json"), "utf8"));
    expect(manifest.id).toBeTruthy();
    expect(manifest.name).toBeTruthy();
    expect(manifest.version).toBeTruthy();
    expect(manifest.personas).toEqual(["agents/ops.persona.md", "agents/res.persona.md"]);
  });

  // The spec calls both mandatory; no code in Buzz reads either.
  test("does NOT emit pack.lock or a .buzzpack checksum", () => {
    const e = env({ ops: { description: "O", skills: [] } });
    const out = join(dir, "pack");
    writePack(e, planPack(e), out);
    expect(existsSync(join(out, "pack.lock"))).toBe(false);
    expect(existsSync(join(out, "hooks"))).toBe(false);
  });
});

describe("findSensitive", () => {
  test("flags a description carrying operator-private terms", () => {
    const plan = planPack(env({ ops: { description: "Deal-floor work for MOB-INTEL with Peter", skills: [] } }));
    expect(findSensitive(plan, ["MOB-INTEL", "Peter"])).toContain("persona 'ops' description");
  });

  test("is quiet for a neutral description, and a no-op with no terms", () => {
    const plan = planPack(env({ ops: { description: "General development tooling", skills: [] } }));
    expect(findSensitive(plan, ["MOB-INTEL"])).toEqual([]);
    expect(findSensitive(plan, [])).toEqual([]);
  });
});

describe("renderManifest", () => {
  test("carries the three required fields and points at real persona paths", () => {
    const plan = planPack(env({ ops: { description: "O", skills: [] } }));
    const m = JSON.parse(renderManifest(plan));
    for (const k of ["id", "name", "version"]) expect(String(m[k]).trim().length).toBeGreaterThan(0);
    expect(m.personas).toEqual(["agents/ops.persona.md"]);
  });
});
