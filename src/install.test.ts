/**
 * install.test.ts — `harbor install --for <agent>` emission + `--write` apply.
 *
 * Pins each agent's emitted config shape (per-agent snapshot) against the formats
 * verified at build time, asserts the emit-don't-mutate contract (emission writes
 * nothing; only applyConfig writes, and only with a backup), and checks the
 * de-personalization invariants. Soak-safe: every path is under a mkdtemp home.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { AGENT_IDS, applyConfig, emitSnippet, renderSnippet, type AgentId } from "./install.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "harbor-install-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Each client's env block is expressed in ITS OWN verified substitution syntax
 * (install.ts's EnvSyntax) — there is no single shared shape, because the
 * clients genuinely disagree and none of them errors on a syntax it does not
 * recognize: it silently hands the template text to the server as the room
 * name. Every expectation below was verified against the real client on
 * 2026-07-23 with an env-probe shim standing in for the server.
 */
/** Claude Code + Gemini CLI: expand ${VAR} AND honor a ${VAR:-default} fallback. */
const SHELL_ENV = {
  AGENT_ENV_ROOM: "${AGENT_ENV_ROOM:-general}",
  AGENT_ENV_SESSION: "${AGENT_ENV_SESSION:-harbor-general}",
};
/** Cursor: VS Code-style ${env:VAR}; plain ${VAR} is not interpolated. */
const VSCODE_ENV = {
  AGENT_ENV_ROOM: "${env:AGENT_ENV_ROOM}",
  AGENT_ENV_SESSION: "${env:AGENT_ENV_SESSION}",
};
/** OpenCode: its own {env:VAR}; ${VAR} reached the server as literal text. */
const OPENCODE_ENV = {
  AGENT_ENV_ROOM: "{env:AGENT_ENV_ROOM}",
  AGENT_ENV_SESSION: "{env:AGENT_ENV_SESSION}",
};

// ── Per-agent snapshots (pin the verified formats) ─────────────────────────--

describe("emitSnippet — per-agent format snapshots", () => {
  test("claude-code: mcpServers JSON with command/args/env", () => {
    const s = emitSnippet("claude-code", { home });
    const doc = JSON.parse(s.snippet);
    expect(doc).toEqual({ mcpServers: { harbor: { command: "harbor", args: ["mcp-server"], env: SHELL_ENV } } });
    expect(s.tier).toBe(1);
    expect(s.instructions).toContain("claude mcp add-json");
  });

  test("cursor: same mcpServers JSON shape, but VS Code ${env:VAR} interpolation", () => {
    const doc = JSON.parse(emitSnippet("cursor", { home }).snippet);
    expect(doc.mcpServers.harbor).toEqual({ command: "harbor", args: ["mcp-server"], env: VSCODE_ENV });
  });

  test("opencode: mcp key, type local, array command, environment", () => {
    const doc = JSON.parse(emitSnippet("opencode", { home }).snippet);
    expect(doc).toEqual({
      mcp: {
        harbor: {
          type: "local",
          command: ["harbor", "mcp-server"],
          enabled: true,
          environment: OPENCODE_ENV,
        },
      },
    });
  });

  // Codex expands nothing AND scrubs the child environment (env_clear + an
  // allowlist), so an env table could only ever pin a literal. env_vars is its
  // sanctioned live passthrough: forwarded when set, omitted when not — which
  // lands on the configured default room rather than a bogus one.
  test("codex: TOML under [mcp_servers.harbor], forwarding via env_vars not env", () => {
    const doc = parseToml(emitSnippet("codex", { home }).snippet) as any;
    expect(doc.mcp_servers.harbor.command).toBe("harbor");
    expect(doc.mcp_servers.harbor.args).toEqual(["mcp-server"]);
    expect(doc.mcp_servers.harbor.env_vars).toEqual(["AGENT_ENV_ROOM", "AGENT_ENV_SESSION"]);
    expect(doc.mcp_servers.harbor.env).toBeUndefined();
  });

  test("gemini: mcpServers JSON shape", () => {
    const doc = JSON.parse(emitSnippet("gemini", { home }).snippet);
    expect(doc.mcpServers.harbor).toEqual({ command: "harbor", args: ["mcp-server"], env: SHELL_ENV });
  });

  test("goose: YAML stdio extension under extensions, with a LITERAL default room", () => {
    const s = emitSnippet("goose", { home }).snippet;
    expect(s).toContain("extensions:");
    expect(s).toContain("  harbor:");
    expect(s).toContain("type: stdio");
    expect(s).toContain("cmd: harbor");
    expect(s).toContain("- mcp-server");
    // NOT the ${VAR} placeholder every other Tier 1 agent gets — confirmed
    // empirically that Goose does not expand it (see renderGooseExtension).
    expect(s).not.toContain("${AGENT_ENV_ROOM}");
    expect(s).toContain("AGENT_ENV_ROOM: general");
    expect(s).toContain("AGENT_ENV_SESSION: harbor-general");
  });

  test("goose: a --room option flows into a literal AGENT_ENV_ROOM + matching session id", () => {
    const s = emitSnippet("goose", { home, room: "legal" }).snippet;
    expect(s).toContain("AGENT_ENV_ROOM: legal");
    expect(s).toContain("AGENT_ENV_SESSION: harbor-legal");
  });

  test("goose: extraInstructions explain the no-substitution gap and the --with-extension workaround", () => {
    const s = emitSnippet("goose", { home });
    expect(s.instructions).toContain("does NOT expand");
    expect(s.instructions).toContain("--with-extension");
  });

  // Antigravity is a DIFFERENT product from the Gemini CLI and must not be
  // conflated with it: same ~/.gemini directory, different file. Conflating
  // them would silently write one agent's config into the other's.
  test("antigravity: mcpServers JSON at its own path, distinct from the Gemini CLI", () => {
    const s = emitSnippet("antigravity", { home });
    expect(s.defaultPath).toBe(join(home, ".gemini", "config", "mcp_config.json"));
    expect(s.defaultPath).not.toBe(emitSnippet("gemini", { home }).defaultPath);
    const doc = JSON.parse(s.snippet);
    expect(doc.mcpServers.harbor.command).toBe("harbor");
    expect(doc.mcpServers.harbor.env.AGENT_ENV_ROOM).toBe("general");
  });

  test("antigravity: --room is baked in literally", () => {
    const doc = JSON.parse(emitSnippet("antigravity", { home, room: "legal" }).snippet);
    expect(doc.mcpServers.harbor.env).toEqual({
      AGENT_ENV_ROOM: "legal",
      AGENT_ENV_SESSION: "harbor-legal",
    });
  });

  test("pi: Tier 2 in-process re-export (no MCP entry)", () => {
    const s = emitSnippet("pi", { home });
    expect(s.tier).toBe(2);
    expect(s.snippet).toContain('export { default } from "harbor-tugboat/integrations/pi"');
  });

  test("orchestrator: one mcp_servers entry per room, each with a LITERAL AGENT_ENV_ROOM", () => {
    const s = emitSnippet("orchestrator", { home, rooms: ["legal", "devops"] });
    expect(s.tier).toBe(1);
    expect(s.snippet).toContain("mcp_servers:");
    expect(s.snippet).toContain("  harbor_legal:");
    expect(s.snippet).toContain("  harbor_devops:");
    // Literal room name, NOT the ${AGENT_ENV_ROOM} placeholder every other
    // agent gets — each connection must stay pinned to its own room
    // regardless of whatever launches the parent orchestrator process.
    expect(s.snippet).toContain("AGENT_ENV_ROOM: legal");
    expect(s.snippet).toContain("AGENT_ENV_ROOM: devops");
    expect(s.snippet).not.toContain("${AGENT_ENV_ROOM}");
    expect(s.snippet).toContain("AGENT_ENV_SESSION: harbor-legal");
    // Instructions cover the two extra steps beyond this file.
    expect(s.instructions).toContain("toolset");
    expect(s.instructions).toContain("custom-toolset mechanism");
  });

  test("orchestrator: zero configured rooms emits a harmless placeholder, not an error", () => {
    const s = emitSnippet("orchestrator", { home, rooms: [] });
    expect(s.snippet).toContain("mcp_servers: {}");
  });

  // Whatever a client's syntax, an explicit --room must be honored: as the
  // `:-default` fallback where the client interpolates, as the literal value
  // where it cannot. Clients that only ever read the live variable (cursor,
  // opencode, codex) legitimately ignore it.
  test("an explicit room reaches every agent that can express one", () => {
    expect(emitSnippet("claude-code", { home, room: "legal" }).snippet).toContain(
      "${AGENT_ENV_ROOM:-legal}",
    );
    expect(emitSnippet("gemini", { home, room: "legal" }).snippet).toContain(
      "${AGENT_ENV_SESSION:-harbor-legal}",
    );
    expect(emitSnippet("goose", { home, room: "legal" }).snippet).toContain("AGENT_ENV_ROOM: legal");
  });

  // No client's emitted room may still be an unsubstituted template of ANOTHER
  // client's dialect — that is exactly what reached the server as a literal
  // room name and, before the isolation fix, unlocked the whole skill pool.
  test("no agent emits a foreign client's placeholder dialect", () => {
    const dialects: Record<string, RegExp> = {
      "claude-code": /\{env:/,
      gemini: /\{env:/,
      cursor: /\$\{AGENT_ENV_ROOM[:}]/,
      opencode: /\$\{AGENT_ENV_ROOM[:}]/,
      goose: /\$\{|\{env:/,
    };
    for (const [agent, forbidden] of Object.entries(dialects)) {
      expect(emitSnippet(agent as AgentId, { home }).snippet).not.toMatch(forbidden);
    }
  });

  test("a custom command/args/serverName flows into the snippet", () => {
    const doc = JSON.parse(
      renderSnippet("json-mcpServers", { command: "npx", args: ["harbor", "mcp-server"], serverName: "hb" }),
    );
    expect(doc.mcpServers.hb).toEqual({ command: "npx", args: ["harbor", "mcp-server"], env: SHELL_ENV });
  });
});

// ── De-personalization ─────────────────────────────────────────────────────--

describe("de-personalization", () => {
  test("no emitted snippet leaks a personal path, command, or room name", () => {
    for (const agent of AGENT_IDS) {
      const s = emitSnippet(agent, { home });
      expect(s.snippet).not.toContain("/Users/");
      expect(s.snippet).not.toContain("/home/");
      // No personal MCP server name leaks ("acme-erp" stands in for any such vendor).
      expect(s.snippet.toLowerCase()).not.toContain("acme-erp");
      // Every agent references AGENT_ENV_ROOM somehow, but the SYNTAX is
      // per-client (install.ts's EnvSyntax) — a single expected string would
      // only re-encode one client's dialect. What must hold universally is
      // that the room is either a variable reference or the harmless generic
      // default "general", never a personal or hand-picked room name. Tier 2
      // (typescript) has no config env block at all.
      // Tier 2 (typescript) has no config env block; the orchestrator emits one
      // connection PER ROOM and so emits an empty placeholder when this loop
      // passes it none — both are covered by their own snapshot tests above.
      if (s.format !== "typescript" && s.format !== "yaml-orchestrator") {
        expect(s.snippet).toContain("AGENT_ENV_ROOM");
        // The only literal room that may be baked in is the harmless generic
        // default. Emitting for a specific room is opt-in via `room`, tested
        // separately below.
        expect(s.snippet).not.toMatch(/\b(legal|devops|finance|marketing|bookkeeping|productivity)\b/);
      }
    }
  });

  test("instructions carry the honest-enforcement note, not an over-claim", () => {
    const s = emitSnippet("claude-code", { home });
    expect(s.instructions.toLowerCase()).toContain("not an os sandbox");
    expect(s.instructions.toLowerCase()).not.toContain("fully enforced");
  });
});

// ── Emit-don't-mutate ──────────────────────────────────────────────────────--

describe("emit does not write", () => {
  test("emitSnippet creates no file", () => {
    const s = emitSnippet("cursor", { home });
    expect(existsSync(s.defaultPath)).toBe(false);
  });
});

// ── --write apply (with backup) ────────────────────────────────────────────--

describe("applyConfig — create, merge, backup, idempotent", () => {
  test("creates a fresh JSON config when none exists (no backup)", () => {
    const r = applyConfig("cursor", { home });
    expect(r.action).toBe("created");
    expect(r.backup).toBeNull();
    const doc = JSON.parse(readFileSync(r.path, "utf8"));
    expect(doc.mcpServers.harbor.command).toBe("harbor");
  });

  test("merges into an existing JSON config, backs it up, preserves other servers", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }, null, 2));

    const r = applyConfig("cursor", { home });
    expect(r.action).toBe("merged");
    expect(r.backup).toBe(`${path}.bak`);
    // Backup holds the original.
    expect(JSON.parse(readFileSync(r.backup!, "utf8")).mcpServers.github.command).toBe("gh-mcp");
    // Merged file keeps github AND adds harbor.
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.mcpServers.github.command).toBe("gh-mcp");
    expect(doc.mcpServers.harbor.command).toBe("harbor");
  });

  test("re-applying is idempotent: unchanged, no new backup", () => {
    applyConfig("gemini", { home });
    const second = applyConfig("gemini", { home });
    expect(second.action).toBe("unchanged");
    expect(second.backup).toBeNull();
  });

  test("a second real change does not clobber the first backup", () => {
    const path = join(home, ".gemini", "settings.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    const first = applyConfig("gemini", { home });
    expect(first.backup).toBe(`${path}.bak`);
    // Force another merge by changing the server name.
    const second = applyConfig("gemini", { home, serverName: "harbor2" });
    expect(second.backup).toBe(`${path}.bak.1`);
  });

  test("codex TOML: merges under [mcp_servers], preserving existing tables", () => {
    const path = join(home, ".codex", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n');
    const r = applyConfig("codex", { home });
    expect(r.action).toBe("merged");
    const doc = parseToml(readFileSync(path, "utf8")) as any;
    expect(doc.model).toBe("o4");
    expect(doc.mcp_servers.other.command).toBe("other-mcp");
    expect(doc.mcp_servers.harbor.command).toBe("harbor");
  });

  test("goose YAML: inserts the harbor extension under an existing extensions block", () => {
    const path = join(home, ".config", "goose", "config.yaml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "extensions:\n  todo:\n    enabled: true\n    type: platform\n");
    const r = applyConfig("goose", { home });
    expect(r.action).toBe("merged");
    expect(r.backup).toBe(`${path}.bak`);
    const out = readFileSync(path, "utf8");
    expect(out).toContain("  todo:"); // preserved
    expect(out).toContain("  harbor:"); // added
    expect(out).toContain("cmd: harbor");
    // Idempotent second apply.
    const second = applyConfig("goose", { home });
    expect(second.action).toBe("unchanged");
  });

  test("goose YAML: creates a fresh extensions section when the file lacks one", () => {
    const path = join(home, ".config", "goose", "config.yaml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "some_other_key: true\n");
    const r = applyConfig("goose", { home });
    expect(r.action).toBe("merged");
    const out = readFileSync(path, "utf8");
    expect(out).toContain("some_other_key: true");
    expect(out).toContain("extensions:");
    expect(out).toContain("  harbor:");
  });

  test("goose YAML: upserts an existing entry with a stale room/missing session in place", () => {
    const path = join(home, ".config", "goose", "config.yaml");
    mkdirSync(dirname(path), { recursive: true });
    // Mirrors the real-world drift this was written to fix: a hardcoded room,
    // AGENT_ENV_SESSION missing entirely, sitting alongside an unrelated
    // extension that must survive untouched.
    writeFileSync(
      path,
      [
        "extensions:",
        "  harbor:",
        "    enabled: true",
        "    type: stdio",
        "    name: harbor",
        "    cmd: harbor",
        "    args:",
        "      - mcp-server",
        "    envs:",
        "      AGENT_ENV_ROOM: productivity",
        "    timeout: 300",
        "    bundled: null",
        "  todo:",
        "    enabled: true",
        "    type: platform",
        "",
      ].join("\n"),
    );
    const r = applyConfig("goose", { home, room: "legal" });
    expect(r.action).toBe("merged");
    expect(r.backup).toBe(`${path}.bak`);
    const out = readFileSync(path, "utf8");
    expect(out).toContain("AGENT_ENV_ROOM: legal");
    expect(out).toContain("AGENT_ENV_SESSION: harbor-legal");
    expect(out).not.toContain("AGENT_ENV_ROOM: productivity");
    expect(out).toContain("  todo:"); // sibling extension untouched
    expect(out).toContain("type: platform");
    // Idempotent: re-applying the same room now is a no-op.
    const second = applyConfig("goose", { home, room: "legal" });
    expect(second.action).toBe("unchanged");
  });

  test("orchestrator: creates a fresh mcp_servers block when the file doesn't exist", () => {
    const r = applyConfig("orchestrator", { home, rooms: ["legal", "devops"] });
    expect(r.action).toBe("created");
    const out = readFileSync(r.path, "utf8");
    expect(out).toContain("  harbor_legal:");
    expect(out).toContain("  harbor_devops:");
  });

  // The load-bearing case: a real orchestrator config.yaml can easily carry
  // live secrets (API tokens, connect URLs) in its OTHER mcp_servers entries
  // — this must be a surgical insertion, never a parse-and-rebuild that could
  // reformat or drop them.
  test("orchestrator: inserts harbor_<room> entries under an existing mcp_servers block, preserving other servers byte-for-byte", () => {
    const path = join(home, ".config", "orchestrator-agent", "mcp.yaml");
    mkdirSync(dirname(path), { recursive: true });
    const original =
      "model:\n  provider: anthropic\n\nmcp_servers:\n  search-api:\n    url: https://mcp.example.com/connect?token=SECRET123\n" +
      "  custom-tool:\n    command: bun\n    args: [\"run\", \"server.ts\"]\n    env:\n      API_KEY: sk-live-abc\n\n" +
      "toolsets:\n  - core-tools\n";
    writeFileSync(path, original);

    const r = applyConfig("orchestrator", { home, rooms: ["legal"] });
    expect(r.action).toBe("merged");
    expect(r.backup).toBe(`${path}.bak`);
    const out = readFileSync(path, "utf8");
    // Every pre-existing line survives untouched, including the secrets.
    expect(out).toContain("url: https://mcp.example.com/connect?token=SECRET123");
    expect(out).toContain("API_KEY: sk-live-abc");
    expect(out).toContain("toolsets:\n  - core-tools");
    // The new entry is present too.
    expect(out).toContain("  harbor_legal:");
    expect(out).toContain("AGENT_ENV_ROOM: legal");
  });

  test("orchestrator: re-applying the same rooms is idempotent, no duplicate entries", () => {
    const opts = { home, rooms: ["legal", "devops"] };
    applyConfig("orchestrator", opts);
    const second = applyConfig("orchestrator", opts);
    expect(second.action).toBe("unchanged");
    expect(second.backup).toBeNull();
    const out = readFileSync(join(home, ".config", "orchestrator-agent", "mcp.yaml"), "utf8");
    expect(out.split("harbor_legal:").length - 1).toBe(1);
  });

  test("orchestrator: a room added to config later only adds that room's entry, leaving existing ones untouched", () => {
    applyConfig("orchestrator", { home, rooms: ["legal"] });
    const r = applyConfig("orchestrator", { home, rooms: ["legal", "devops"] });
    expect(r.action).toBe("merged");
    const out = readFileSync(r.path, "utf8");
    expect(out).toContain("  harbor_legal:");
    expect(out).toContain("  harbor_devops:");
    expect(out.split("harbor_legal:").length - 1).toBe(1); // not duplicated
  });

  test("pi: writes the dedicated extension file, idempotent on re-apply", () => {
    const first = applyConfig("pi", { home });
    expect(first.action).toBe("created");
    expect(readFileSync(first.path, "utf8")).toContain("harbor-tugboat/integrations/pi");
    const second = applyConfig("pi", { home });
    expect(second.action).toBe("unchanged");
  });

  test("an explicit --path overrides the default location", () => {
    const custom = join(home, "custom", "mcp.json");
    const r = applyConfig("cursor", { home, path: custom });
    expect(r.path).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });
});

// ── every agent emits + applies without throwing ───────────────────────────--

describe("coverage: all eight agents", () => {
  test("emit + write succeed for every agent id", () => {
    for (const agent of AGENT_IDS as AgentId[]) {
      // The orchestrator target needs rooms to actually have something to
      // write; every other agent ignores the option.
      const opts = agent === "orchestrator" ? { home, rooms: ["legal", "devops"] } : { home };
      const s = emitSnippet(agent, opts);
      expect(s.snippet.length).toBeGreaterThan(0);
      const r = applyConfig(agent, opts);
      expect(["created", "merged"]).toContain(r.action);
      expect(existsSync(r.path)).toBe(true);
    }
  });
});
