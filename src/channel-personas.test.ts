/**
 * channel-personas.test.ts — Channel → room persona resolution + policy edits.
 *
 * Room persona files live at `<env.rooms>/<room>/agents/<name>.md`; the policy
 * file is the same `channel-tools.toml` buzz-acp reads. Soak-safe: everything
 * lives under a mkdtemp root, no test touches the live `~/.buzz` or `~/rooms`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listRoomPersonas,
  matchRoomPersona,
  removeChannelPersona,
  resolveChannelPersona,
  setChannelPersonaFile,
  syncChannelPersona,
} from "./channel-personas.ts";
import { loadPolicy as loadPolicyLocal } from "./channel-tools.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-personas-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(rooms: Record<string, unknown> = {}): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { skills_dir: join(dir, "pool") }, skills: { rooms } }));
  return new Environment(dir, cfg);
}

/** Write a persona file into `<rooms>/<room>/agents/<name>.md`. */
function writePersona(room: string, name: string, body = `## Identity\nYou are the ${name}.\n`): string {
  const d = join(dir, "rooms", room, "agents");
  mkdirSync(d, { recursive: true });
  const p = join(d, `${name}.md`);
  writeFileSync(p, `# ${name}\n\n> harvested note\n\n${body}`);
  return p;
}

function writePolicy(body: string): string {
  const p = join(dir, "channel-tools.toml");
  writeFileSync(p, body);
  return p;
}

describe("matchRoomPersona", () => {
  const p = (name: string) => ({ name, path: `/x/${name}.md`, preview: "" });

  test("exact name match", () => {
    expect(matchRoomPersona("fleet-maintainer", [p("fleet-maintainer"), p("automation-architect")])?.name).toBe("fleet-maintainer");
  });
  test("specialization: channel name contains the persona name", () => {
    const personas = [p("facilities-security"), p("legal-financial-researcher"), p("compliance-officer")];
    expect(matchRoomPersona("legal-facilities-security", personas)?.name).toBe("facilities-security");
  });
  test("sole persona in the room is used", () => {
    expect(matchRoomPersona("support", [p("support-agent")])?.name).toBe("support-agent");
  });
  test("ambiguous (several, no match) → null", () => {
    expect(matchRoomPersona("devops", [p("fleet-maintainer"), p("automation-architect")])).toBeNull();
  });
  test("room-prefixed channel matches on the distinctive token (legal-compliance → compliance-officer)", () => {
    const legal = [p("compliance-officer"), p("facilities-security"), p("legal-financial-researcher")];
    expect(matchRoomPersona("legal-compliance", legal, "legal")?.name).toBe("compliance-officer");
    expect(matchRoomPersona("legal-facilities-security", legal, "legal")?.name).toBe("facilities-security");
  });
  test("bare room-name channel stays ambiguous (legal → null)", () => {
    const legal = [p("compliance-officer"), p("facilities-security"), p("legal-financial-researcher")];
    expect(matchRoomPersona("legal", legal, "legal")).toBeNull();
  });
  test("empty room → null", () => {
    expect(matchRoomPersona("x", [])).toBeNull();
  });
});

describe("listRoomPersonas", () => {
  test("lists agent files with a preview, skipping title/provenance", () => {
    writePersona("support", "support-agent");
    const list = listRoomPersonas(env(), "support");
    expect(list.map((p) => p.name)).toEqual(["support-agent"]);
    expect(list[0]!.preview).toBe("You are the support-agent.");
  });
  test("missing agents dir → empty", () => {
    expect(listRoomPersonas(env(), "gaming")).toEqual([]);
  });
});

describe("resolveChannelPersona", () => {
  test("auto-derives the room persona when unambiguous", () => {
    writePersona("support", "support-agent");
    const p = writePolicy(`[channels.support]\nroom = "support"\n`);
    const r = resolveChannelPersona(env(), p, "support");
    expect(r.effective?.source).toBe("room");
    expect(r.effective?.name).toBe("support-agent");
    expect(r.overridden).toBe(false);
  });
  test("ambiguous room → no effective persona, ambiguous flag set", () => {
    writePersona("devops", "fleet-maintainer");
    writePersona("devops", "automation-architect");
    const p = writePolicy(`[channels.devops]\nroom = "devops"\n`);
    const r = resolveChannelPersona(env(), p, "devops");
    expect(r.effective).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.roomOptions.map((o) => o.name).sort()).toEqual(["automation-architect", "fleet-maintainer"]);
  });
  test("explicit persona_file override wins over room-auto", () => {
    writePersona("support", "support-agent");
    const custom = join(dir, "custom.md");
    writeFileSync(custom, "## Identity\nYou are a custom override.\n");
    const p = writePolicy(`[channels.support]\nroom = "support"\npersona_file = "${custom}"\n`);
    const r = resolveChannelPersona(env(), p, "support");
    expect(r.overridden).toBe(true);
    expect(r.effective?.source).toBe("override-file");
    expect(r.effective?.preview).toBe("You are a custom override.");
  });
});

describe("setChannelPersonaFile / removeChannelPersona", () => {
  test("sets persona_file, preserving comments and other entries", () => {
    const p = writePolicy(`# top comment\nharbor_command = "harbor"\n\n[channels.support]\nroom = "support"\n\n[channels.legal]\nroom = "legal"\n`);
    setChannelPersonaFile(p, "support", "/rooms/support/agents/support-agent.md");
    const text = readFileSync(p, "utf8");
    expect(text).toContain("# top comment");
    expect(text).toContain(`persona_file = "/rooms/support/agents/support-agent.md"`);
    // legal entry untouched
    const { channels } = loadPolicyLocal(p);
    expect(channels.get("support")?.personaFile).toBe("/rooms/support/agents/support-agent.md");
    expect(channels.get("legal")?.personaFile).toBeNull();
  });
  test("set is idempotent — replaces, does not stack", () => {
    const p = writePolicy(`[channels.x]\nroom = "x"\n`);
    setChannelPersonaFile(p, "x", "/a.md");
    setChannelPersonaFile(p, "x", "/b.md");
    const matches = readFileSync(p, "utf8").match(/persona_file/g) ?? [];
    expect(matches.length).toBe(1);
    expect(readFileSync(p, "utf8")).toContain(`persona_file = "/b.md"`);
  });
  test("remove clears the override back to none", () => {
    const p = writePolicy(`[channels.x]\nroom = "x"\npersona_file = "/a.md"\n`);
    removeChannelPersona(p, "x");
    expect(readFileSync(p, "utf8")).not.toContain("persona_file");
    expect(readFileSync(p, "utf8")).toContain(`room = "x"`);
  });
  test("case-insensitive channel key match", () => {
    const p = writePolicy(`[channels.Support]\nroom = "support"\n`);
    setChannelPersonaFile(p, "support", "/a.md");
    expect((readFileSync(p, "utf8").match(/\[channels\./g) ?? []).length).toBe(1); // no duplicate section
    expect(readFileSync(p, "utf8")).toContain(`persona_file = "/a.md"`);
  });
});

describe("syncChannelPersona", () => {
  test("applies the room persona for an unambiguous channel", () => {
    const path = writePersona("support", "support-agent");
    const p = writePolicy(`[channels.support]\nroom = "support"\n`);
    const res = syncChannelPersona(env(), p, "support");
    expect(res.synced).toBe(true);
    expect(res.path).toBe(path);
    expect(readFileSync(p, "utf8")).toContain(`persona_file = "${path}"`);
  });
  test("a synced pointer still reads as 'from room' (not a custom override)", () => {
    writePersona("support", "support-agent");
    const p = writePolicy(`[channels.support]\nroom = "support"\n`);
    syncChannelPersona(env(), p, "support");
    const r = resolveChannelPersona(env(), p, "support");
    expect(r.effective?.source).toBe("room"); // it IS the room persona, just applied
    expect(r.effective?.name).toBe("support-agent");
    expect(r.overridden).toBe(true); // but there's a persona_file to remove
  });
  test("skips an ambiguous channel", () => {
    writePersona("devops", "fleet-maintainer");
    writePersona("devops", "automation-architect");
    const p = writePolicy(`[channels.devops]\nroom = "devops"\n`);
    const res = syncChannelPersona(env(), p, "devops");
    expect(res.synced).toBe(false);
    expect(readFileSync(p, "utf8")).not.toContain("persona_file");
  });
  test("does not overwrite an existing override", () => {
    writePersona("support", "support-agent");
    const p = writePolicy(`[channels.support]\nroom = "support"\npersona_file = "/mine.md"\n`);
    const res = syncChannelPersona(env(), p, "support");
    expect(res.synced).toBe(false);
    expect(readFileSync(p, "utf8")).toContain(`persona_file = "/mine.md"`);
  });
});

