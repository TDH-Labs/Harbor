/**
 * channel-tools.test.ts — Buzz channel → room toolset resolution.
 *
 * The policy-file schema is pinned to buzz-acp's deserializer (top-level
 * `harbor_command`, `[channels.<key>] room`, `[[channels.X.mcp]]`). Soak-safe:
 * pool + config + policy all live under a mkdtemp root; no test reads the live
 * `~/.buzz/channel-tools.toml`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChannelToolsError,
  deriveRoomName,
  findChannelPolicy,
  listChannels,
  loadPolicy,
  mapChannel,
  resolveChannelTools,
} from "./channel-tools.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-chtools-"));
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
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\n# ${name}\n`);
}

function writePolicy(body: string): string {
  const p = join(dir, "channel-tools.toml");
  writeFileSync(p, body);
  return p;
}

describe("loadPolicy", () => {
  test("parses harbor_command and channel → room entries", () => {
    const p = writePolicy(
      `harbor_command = "/opt/harbor"\n[channels.bookkeeping]\nroom = "bookkeeping"\n[channels.legal]\nroom = "legal"\n`,
    );
    const { harborCommand, channels } = loadPolicy(p);
    expect(harborCommand).toBe("/opt/harbor");
    expect(channels.get("bookkeeping")?.room).toBe("bookkeeping");
    expect(channels.get("legal")?.room).toBe("legal");
  });

  test("defaults harbor_command to 'harbor' when absent", () => {
    const p = writePolicy(`[channels.x]\nroom = "x"\n`);
    expect(loadPolicy(p).harborCommand).toBe("harbor");
  });

  test("parses explicit inline MCP servers", () => {
    const p = writePolicy(
      `[channels.ops]\nroom = "devops"\n[[channels.ops.mcp]]\nname = "grafana"\ncommand = "grafana-mcp"\nargs = ["--port", "9000"]\n`,
    );
    const entry = loadPolicy(p).channels.get("ops");
    expect(entry?.explicitMcp).toEqual([{ name: "grafana", command: "grafana-mcp", args: ["--port", "9000"] }]);
  });

  test("a channel entry with no room resolves room to null", () => {
    const p = writePolicy(`[channels.blank]\n`);
    expect(loadPolicy(p).channels.get("blank")?.room).toBeNull();
  });

  test("throws ChannelToolsError when the file is missing", () => {
    expect(() => loadPolicy(join(dir, "nope.toml"))).toThrow(ChannelToolsError);
  });
});

describe("findChannelPolicy", () => {
  test("matches case-insensitively by name (buzz-acp's rule)", () => {
    const { channels } = loadPolicy(writePolicy(`[channels.Legal]\nroom = "legal"\n`));
    expect(findChannelPolicy(channels, "legal")?.room).toBe("legal");
    expect(findChannelPolicy(channels, "LEGAL")?.room).toBe("legal");
  });

  test("prefers an exact key over a case-folded one", () => {
    const { channels } = loadPolicy(writePolicy(`[channels.ops]\nroom = "a"\n[channels.OPS]\nroom = "b"\n`));
    expect(findChannelPolicy(channels, "ops")?.room).toBe("a");
  });

  test("returns null for an unmapped channel", () => {
    const { channels } = loadPolicy(writePolicy(`[channels.x]\nroom = "x"\n`));
    expect(findChannelPolicy(channels, "missing")).toBeNull();
  });
});

describe("resolveChannelTools", () => {
  test("resolves a scoped channel's room skills, marking presence", () => {
    writeSkill("present-skill");
    const e = env({ legal: { skills: ["present-skill", "ghost-skill"], mcp: { servers: [{ name: "docsign" }] } } });
    const p = writePolicy(`[channels.legal]\nroom = "legal"\n`);

    const tools = resolveChannelTools(e, p, "legal");
    expect(tools.scoped).toBe(true);
    expect(tools.room).toBe("legal");
    const byName = new Map(tools.skills.map((s) => [s.name, s]));
    expect(byName.get("present-skill")?.present).toBe(true);
    expect(byName.get("present-skill")?.description).toBe("present-skill does a thing");
    expect(byName.get("ghost-skill")?.present).toBe(false); // listed by the room, absent from the pool
    expect(tools.mcpServers).toEqual([{ name: "docsign", source: "room" }]);
  });

  test("merges room-configured and inline-explicit MCP servers", () => {
    const e = env({ devops: { skills: [], mcp: { servers: [{ name: "prometheus" }] } } });
    const p = writePolicy(
      `[channels.ops]\nroom = "devops"\n[[channels.ops.mcp]]\nname = "grafana"\ncommand = "grafana-mcp"\n`,
    );
    const tools = resolveChannelTools(e, p, "ops");
    expect(tools.mcpServers).toEqual([
      { name: "prometheus", source: "room" },
      { name: "grafana", source: "explicit" },
    ]);
  });

  test("an unmapped channel is not scoped and lists nothing", () => {
    const e = env({});
    const p = writePolicy(`[channels.legal]\nroom = "legal"\n`);
    const tools = resolveChannelTools(e, p, "marketing");
    expect(tools.scoped).toBe(false);
    expect(tools.room).toBeNull();
    expect(tools.skills).toEqual([]);
    expect(tools.mcpServers).toEqual([]);
  });

  test("a mapped-but-roomless channel is scoped, exposing only its explicit MCP", () => {
    const e = env({});
    const p = writePolicy(`[channels.blank]\n[[channels.blank.mcp]]\nname = "solo"\ncommand = "solo-mcp"\n`);
    const tools = resolveChannelTools(e, p, "blank");
    expect(tools.scoped).toBe(true);
    expect(tools.room).toBeNull();
    expect(tools.mcpServers).toEqual([{ name: "solo", source: "explicit" }]);
  });
});

describe("listChannels", () => {
  test("returns every mapped channel with its room, sorted by channel", () => {
    const p = writePolicy(`[channels.zeta]\nroom = "z"\n[channels.alpha]\nroom = "a"\n`);
    expect(listChannels(p)).toEqual([
      { channel: "alpha", room: "a" },
      { channel: "zeta", room: "z" },
    ]);
  });
});

describe("deriveRoomName", () => {
  test("uses a channel that is already a legal room name verbatim", () => {
    expect(deriveRoomName("welcome-everyone")).toBe("welcome-everyone");
    expect(deriveRoomName("legal")).toBe("legal");
  });

  test("slugifies a channel with spaces/punctuation to the room charset", () => {
    expect(deriveRoomName("Welcome Everyone!")).toBe("welcome_everyone");
    expect(deriveRoomName("  🎉 party time  ")).toBe("party_time");
  });
});

describe("mapChannel", () => {
  // mapChannel writes Harbor's config (room creation), so it needs an env with
  // a real config path — build one the way config-edit's tests do.
  function envWithConfig(): Environment {
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      `[paths]\nskills_dir = "${join(dir, "pool")}"\n\n[skills.rooms.legal]\nskills = ["nda-review"]\n`,
    );
    return new Environment(dir, Config.load(configPath), configPath);
  }

  test("scopes a brand-new channel: creates its room and appends the mapping", () => {
    const e = envWithConfig();
    const p = writePolicy(`# keep me\nharbor_command = "harbor"\n\n[channels.legal]\nroom = "legal"\n`);

    const res = mapChannel(e, p, "welcome-everyone");
    expect(res).toEqual({ channel: "welcome-everyone", room: "welcome-everyone", mappingCreated: true });

    // Existing entry + comment preserved, new entry present.
    const text = readFileSync(p, "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("[channels.legal]");
    const { channels } = loadPolicy(p);
    expect(findChannelPolicy(channels, "welcome-everyone")?.room).toBe("welcome-everyone");
    // Room now exists in Harbor config.
    expect(e.config.roomSkillSet("welcome-everyone").size).toBe(0);
  });

  test("is idempotent — a mapped channel keeps its room and file is not duplicated", () => {
    const e = envWithConfig();
    const p = writePolicy(`[channels.legal]\nroom = "legal"\n`);
    const res = mapChannel(e, p, "legal");
    expect(res).toEqual({ channel: "legal", room: "legal", mappingCreated: false });
    // Only one [channels.legal] table.
    expect(readFileSync(p, "utf8").match(/\[channels\.legal\]/g)?.length).toBe(1);
  });

  test("honors an explicit room override", () => {
    const e = envWithConfig();
    const p = writePolicy(`harbor_command = "harbor"\n`);
    const res = mapChannel(e, p, "welcome-everyone", "greeters");
    expect(res.room).toBe("greeters");
    expect(loadPolicy(p).channels.get("welcome-everyone")?.room).toBe("greeters");
  });

  test("quotes a channel key that isn't a bare TOML key, and stays parseable", () => {
    const e = envWithConfig();
    const p = writePolicy(`harbor_command = "harbor"\n`);
    const res = mapChannel(e, p, "team lunch");
    expect(res.mappingCreated).toBe(true);
    // The written file must still parse and resolve by the original key.
    const { channels } = loadPolicy(p);
    expect(findChannelPolicy(channels, "team lunch")?.room).toBe(res.room);
  });

  test("throws on an invalid explicit room name", () => {
    const e = envWithConfig();
    const p = writePolicy(`harbor_command = "harbor"\n`);
    expect(() => mapChannel(e, p, "welcome-everyone", "bad room!")).toThrow(ChannelToolsError);
  });
});
