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

const EXPECTED_ENV = { AGENT_ENV_ROOM: "${AGENT_ENV_ROOM}", AGENT_ENV_SESSION: "${AGENT_ENV_SESSION}" };

// ── Per-agent snapshots (pin the verified formats) ─────────────────────────--

describe("emitSnippet — per-agent format snapshots", () => {
  test("claude-code: mcpServers JSON with command/args/env", () => {
    const s = emitSnippet("claude-code", { home });
    const doc = JSON.parse(s.snippet);
    expect(doc).toEqual({ mcpServers: { harbor: { command: "harbor", args: ["mcp-server"], env: EXPECTED_ENV } } });
    expect(s.tier).toBe(1);
    expect(s.instructions).toContain("claude mcp add-json");
  });

  test("cursor: same mcpServers JSON shape", () => {
    const doc = JSON.parse(emitSnippet("cursor", { home }).snippet);
    expect(doc.mcpServers.harbor).toEqual({ command: "harbor", args: ["mcp-server"], env: EXPECTED_ENV });
  });

  test("opencode: mcp key, type local, array command, environment", () => {
    const doc = JSON.parse(emitSnippet("opencode", { home }).snippet);
    expect(doc).toEqual({
      mcp: {
        harbor: {
          type: "local",
          command: ["harbor", "mcp-server"],
          enabled: true,
          environment: EXPECTED_ENV,
        },
      },
    });
  });

  test("codex: TOML under [mcp_servers.harbor]", () => {
    const doc = parseToml(emitSnippet("codex", { home }).snippet) as any;
    expect(doc.mcp_servers.harbor.command).toBe("harbor");
    expect(doc.mcp_servers.harbor.args).toEqual(["mcp-server"]);
    expect(doc.mcp_servers.harbor.env).toEqual(EXPECTED_ENV);
  });

  test("gemini: mcpServers JSON shape", () => {
    const doc = JSON.parse(emitSnippet("gemini", { home }).snippet);
    expect(doc.mcpServers.harbor).toEqual({ command: "harbor", args: ["mcp-server"], env: EXPECTED_ENV });
  });

  test("goose: YAML stdio extension under extensions", () => {
    const s = emitSnippet("goose", { home }).snippet;
    expect(s).toContain("extensions:");
    expect(s).toContain("  harbor:");
    expect(s).toContain("type: stdio");
    expect(s).toContain("cmd: harbor");
    expect(s).toContain("- mcp-server");
    expect(s).toContain("AGENT_ENV_ROOM: ${AGENT_ENV_ROOM}");
  });

  test("pi: Tier 2 in-process re-export (no MCP entry)", () => {
    const s = emitSnippet("pi", { home });
    expect(s.tier).toBe(2);
    expect(s.snippet).toContain('export { default } from "harbor-tugboat/integrations/pi"');
  });

  test("a custom command/args/serverName flows into the snippet", () => {
    const doc = JSON.parse(
      renderSnippet("json-mcpServers", { command: "npx", args: ["harbor", "mcp-server"], serverName: "hb" }),
    );
    expect(doc.mcpServers.hb).toEqual({ command: "npx", args: ["harbor", "mcp-server"], env: EXPECTED_ENV });
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
      // Only the generic command and ${VAR} env references appear.
      if (s.format !== "typescript") {
        expect(s.snippet).toContain("${AGENT_ENV_ROOM}");
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

describe("coverage: all seven agents", () => {
  test("emit + write succeed for every agent id", () => {
    for (const agent of AGENT_IDS as AgentId[]) {
      const s = emitSnippet(agent, { home });
      expect(s.snippet.length).toBeGreaterThan(0);
      const r = applyConfig(agent, { home });
      expect(["created", "merged"]).toContain(r.action);
      expect(existsSync(r.path)).toBe(true);
    }
  });
});
