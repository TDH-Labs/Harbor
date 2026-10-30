/**
 * muse-code.test.ts — Harbor ↔ Muse Code skill sync.
 *
 * Muse discovers the whole Harbor pool on the filesystem
 * ($HOME/.agents/skills = its user skills; a trusted home-root workspace
 * also surfaces it as project skills). Harbor must scope that native
 * loading to one room via Muse's own skills.activation settings —
 * without touching the pool or any other agent. Soak-safe: temp-dir root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import {
  computeMuseActivation,
  museSettingsPath,
  persistMuseRoom,
  resolveMuseRoom,
  syncMuseCode,
} from "./muse-code.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-muse-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEnv(): Environment {
  const cfg = new Config(
    deepMerge(DEFAULTS, {
      skills: {
        default_room: "productivity",
        rooms: {
          productivity: { skills: ["alpha", "shared"] },
          legal: { skills: ["beta", "shared"] },
        },
      },
    }),
  );
  const env = new Environment(dir, cfg);
  for (const name of ["alpha", "beta", "shared", "orphan"]) {
    const d = join(env.skillsDir, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`);
  }
  return env;
}

function installMuse(root: string, settings?: Record<string, unknown>): string {
  const p = museSettingsPath(root);
  mkdirSync(join(root, ".config", "muse"), { recursive: true });
  if (settings) writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
  return p;
}

describe("computeMuseActivation", () => {
  test("disables every pool skill outside the room at user + project scope", () => {
    // "orphan" is in no room's list, so Harbor assigns it to the default
    // room (productivity) — same rule `harbor skills-list --room` applies.
    const act = computeMuseActivation(makeEnv(), "productivity");
    expect(act.enabled.sort()).toEqual(["alpha", "orphan", "shared"]);
    expect(act.disabled.sort()).toEqual(["beta"]);
    expect(act.user["$HOME/.agents/skills/beta/SKILL.md"]).toBe("off");
    expect(act.project[".agents/skills/beta/SKILL.md"]).toBe("off");
    expect(act.user["$HOME/.agents/skills/alpha/SKILL.md"]).toBeUndefined();
  });

  test("a skill granted in several rooms stays enabled in each", () => {
    const act = computeMuseActivation(makeEnv(), "legal");
    expect(act.enabled.sort()).toEqual(["beta", "shared"]);
  });
});

describe("resolveMuseRoom", () => {
  test("explicit wins, then persisted, then configured default", () => {
    const env = makeEnv();
    expect(resolveMuseRoom(env)).toBe("productivity");
    persistMuseRoom(env, "legal");
    expect(resolveMuseRoom(env)).toBe("legal");
    expect(resolveMuseRoom(env, "productivity")).toBe("productivity");
  });

  test("unknown persisted room falls back to the default room", () => {
    const env = makeEnv();
    persistMuseRoom(env, "no-such-room");
    expect(resolveMuseRoom(env)).toBe("productivity");
  });
});

describe("syncMuseCode", () => {
  test("no-op when Muse is not installed", () => {
    const res = syncMuseCode(makeEnv());
    expect(res.action).toBe("absent");
    expect(existsSync(museSettingsPath(dir))).toBe(false);
  });

  test("writes activation, preserves unrelated settings, is idempotent", () => {
    const env = makeEnv();
    const p = installMuse(dir, { schema_version: 1, provider: "meta", model: "muse-wonder-1.0" });
    const first = syncMuseCode(env);
    expect(first).toMatchObject({ action: "synced", changed: true, room: "productivity", enabled: 3, disabled: 1 });
    const doc = JSON.parse(readFileSync(p, "utf8"));
    expect(doc.provider).toBe("meta");
    expect(doc.model).toBe("muse-wonder-1.0");
    expect(doc.skills.activation.user["$HOME/.agents/skills/beta/SKILL.md"]).toBe("off");
    expect(doc.skills.activation.projects[dir][".agents/skills/beta/SKILL.md"]).toBe("off");
    expect(doc.skills.activation.user["$HOME/.agents/skills/alpha/SKILL.md"]).toBeUndefined();
    expect(syncMuseCode(env).changed).toBe(false);
  });

  test("re-scoping removes stale offs for the new room's skills only", () => {
    const env = makeEnv();
    const p = installMuse(dir, {});
    syncMuseCode(env);
    persistMuseRoom(env, "legal");
    syncMuseCode(env);
    const doc = JSON.parse(readFileSync(p, "utf8"));
    expect(doc.skills.activation.user["$HOME/.agents/skills/beta/SKILL.md"]).toBeUndefined();
    expect(doc.skills.activation.user["$HOME/.agents/skills/alpha/SKILL.md"]).toBe("off");
    // shared is in both rooms: never disabled.
    expect(doc.skills.activation.user["$HOME/.agents/skills/shared/SKILL.md"]).toBeUndefined();
  });

  test("preserves a user's own non-pool activation entries", () => {
    const env = makeEnv();
    const p = installMuse(dir, {
      skills: { activation: { user: { "$HOME/.agents/skills/personal-skill/SKILL.md": "off" } } },
    });
    syncMuseCode(env);
    const doc = JSON.parse(readFileSync(p, "utf8"));
    expect(doc.skills.activation.user["$HOME/.agents/skills/personal-skill/SKILL.md"]).toBe("off");
  });

  test("never clobbers an unparseable settings file", () => {
    const env = makeEnv();
    const p = installMuse(dir);
    writeFileSync(p, "{ not json");
    const res = syncMuseCode(env);
    expect(res.action).toBe("skipped");
    expect(readFileSync(p, "utf8")).toBe("{ not json");
  });
});
