/**
 * cli.test.ts — CLI command coverage.
 *
 * Determinism note (Phase-4 gate): the bulk of these assertions run the command
 * tree IN-PROCESS via citty's `runCommand`/`renderUsage` — the same handler code
 * a subprocess would run, but without spawning a `bun` per case. The earlier
 * version spawned ~36 `bun cli.ts` subprocesses (a 19-command `--help` loop plus
 * the functional cases); under a concurrent load burst alongside the other
 * spawn-heavy suites, that fan-out was the machine-load source correlated with the
 * gate's flakiness. A handful of true end-to-end subprocess smokes remain to prove
 * the binary actually launches, parses args, loads config, and exits cleanly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderUsage, runCommand } from "citty";

import { main } from "./cli.ts";

const CLI = join(import.meta.dir, "cli.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Spawn the real CLI binary in a subprocess (true end-to-end). Used sparingly. */
function run(...args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

/**
 * Run a command IN-PROCESS through the same citty tree the binary uses, capturing
 * stdout/stderr and the resolved exit code. No subprocess is spawned. `process.exitCode`
 * is saved/restored so a command that signals failure in-process can never set the
 * test runner's own exit code.
 */
async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = [];
  const sink = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
  };
  const origLog = console.log;
  const origErr = console.error;
  const savedExit = process.exitCode;
  console.log = sink as typeof console.log;
  console.error = sink as typeof console.error;
  process.exitCode = 0;
  let threw = false;
  try {
    await runCommand(main, { rawArgs: args });
  } catch (err) {
    threw = true;
    sink(err instanceof Error ? err.message : String(err));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const code = threw ? 1 : typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = savedExit;
  return { code, out: logs.join("\n") };
}

/** Write a config.toml under the temp dir and return its path. */
function writeConfig(): string {
  const cfg = join(dir, "config.toml");
  writeFileSync(
    cfg,
    [
      "[paths]",
      `home = "${dir}"`,
      'skills_dir = "~/.agents/skills"',
      'state_dir = "~/.agent-env"',
      "",
      "[skills]",
      'default_room = "research"',
      "",
      "[skills.rooms.research]",
      'description = "Research and analysis"',
      "skills = []",
      "",
      "[skills.rooms.devops]",
      'description = "Infra and CI"',
      "skills = []",
      "",
      "[[skills.rooms.devops.mcp.servers]]",
      'name = "filesystem"',
      'command = "echo"',
      'args = ["-y", "server-filesystem"]',
      "",
    ].join("\n"),
  );
  return cfg;
}

// ── True end-to-end subprocess smokes (kept deliberately small) ───────────────--
// One spawn per surface: the binary launches + help path, a core file-writing
// command, the SQLite-backed scheduler, and the config-loading skill tooling.

describe("end-to-end (subprocess) smokes", () => {
  test("root --help exits 0 and lists subcommands (binary + runMain help path)", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("scheduler");
  });

  test("--version prints the package version (citty version path)", () => {
    const r = run("--version");
    expect(r.code).toBe(0);
    expect((r.out + r.err).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("setup builds the directory tree under --root through a real process", () => {
    const r = run("setup", "--root", dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("setup:");
    for (const sub of ["workspace", "rooms", "data", "archive", ".agent-env"]) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- agent-env:sync -->");
  });

  test("setup seeds the extending-harbor skill into the pool", () => {
    run("setup", "--root", dir);
    const skill = join(dir, ".agents", "skills", "extending-harbor", "SKILL.md");
    expect(existsSync(skill)).toBe(true);
    const body = readFileSync(skill, "utf8");
    expect(body).toContain("name: extending-harbor");
    expect(body).toContain("harbor skill-install");
    // Idempotent: a second setup does not re-seed or error.
    const r2 = run("setup", "--root", dir);
    expect(r2.code).toBe(0);
    expect(r2.out).not.toContain("seeded extending-harbor skill");
  });

  test("init writes agent_map.md + a stamped AGENTS.md through a real process", () => {
    const r = run("init", "--root", dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "agent_map.md"))).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- agent-env:sync -->");
  });

  test("scheduler stats opens its SQLite DB and reports state counts", () => {
    const r = run("scheduler", "stats", "--root", dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tasks by state:");
    expect(r.out).toContain("queued:");
  });

  test("skills-list loads --config in a real process", () => {
    const cfg = writeConfig();
    const r = run("skills-list", "--config", cfg);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no skills in pool");
  });
});

// ── Per-subcommand help (in-process usage rendering) ──────────────────────────--

describe("--help renders for every subcommand", () => {
  const commands = [
    "sync", "watch", "start", "stop", "dashboard", "bench",
    "scheduler", "compaction", "isolation", "session", "check", "init", "setup",
    "skills-list", "mcp-check", "mcp-gen", "mcp-merge",
    "skill-create", "skill-install", "skill-assign", "skill-room-add",
  ];
  const subCommands = (main as unknown as { subCommands: Record<string, unknown> }).subCommands;
  for (const cmd of commands) {
    test(`${cmd} usage renders and names the command`, async () => {
      const sub = subCommands[cmd];
      expect(sub).toBeDefined();
      const usage = await renderUsage(sub as Parameters<typeof renderUsage>[0], main as Parameters<typeof renderUsage>[1]);
      expect(usage.toLowerCase()).toContain(cmd);
    });
  }
});

// ── Functional command behavior (in-process) ──────────────────────────────────--

describe("init + sync (in-process)", () => {
  test("init seeds agent_map.md and a stamped AGENTS.md", async () => {
    const r = await cli("init", "--root", dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "agent_map.md"))).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- agent-env:sync -->");
  });

  test("sync --generate-only produces AGENTS.md with the sync stamp", async () => {
    const r = await cli("sync", "--generate-only", "--root", dir);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- agent-env:sync -->");
  });
});

describe("session round-trip (in-process)", () => {
  test("start then active reports the live session", async () => {
    const start = await cli("session", "start", "ops", "5000", "--root", dir);
    expect(start.code).toBe(0);
    expect(start.out).toContain("started in ops");

    const active = await cli("session", "active", "--root", dir);
    expect(active.code).toBe(0);
    expect(active.out).toContain("ops");
  });
});

describe("scheduler (in-process)", () => {
  test("prints task counts by state", async () => {
    const r = await cli("scheduler", "stats", "--root", dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tasks by state:");
    expect(r.out).toContain("queued:");
  });

  test("submit then list shows the task", async () => {
    const submit = await cli("scheduler", "submit", "cleanup", "--room", "devops", "--priority", "5", "--root", dir);
    expect(submit.code).toBe(0);
    expect(submit.out).toContain("queued task");

    const list = await cli("scheduler", "list", "--root", dir);
    expect(list.out).toContain("devops/cleanup");
  });
});

describe("isolation rooms (in-process)", () => {
  test("reports no rooms under the default (de-personalized) config", async () => {
    const r = await cli("isolation", "rooms", "--root", dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(no rooms configured)");
  });
});

describe("Phase 4 skill / MCP tooling (acceptance criteria, in-process)", () => {
  test("skill-create test-skill --no-register scaffolds a valid skill dir", async () => {
    const cfg = writeConfig();
    const wip = join(dir, "wip");
    const r = await cli("skill-create", "test-skill", "--no-register", "--dir", wip, "--config", cfg);
    expect(r.code).toBe(0);
    const skillDir = join(wip, "test-skill");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, "tests", "test_scenario.md"))).toBe(true);
    expect(existsSync(join(skillDir, "examples", "basic_usage.md"))).toBe(true);
    expect(existsSync(join(skillDir, "README.md"))).toBe(true);
  });

  test("mcp-check --room devops validates the server", async () => {
    const cfg = writeConfig();
    const r = await cli("mcp-check", "--room", "devops", "--config", cfg);
    expect(r.code).toBe(0);
    expect(r.out).toContain("devops/filesystem");
  });

  test("mcp-merge research devops -o file produces a valid merged config", async () => {
    const cfg = writeConfig();
    const out = join(dir, "merged.json");
    const r = await cli("mcp-merge", "research", "devops", "-o", out, "--config", cfg);
    expect(r.code).toBe(0);
    const merged = JSON.parse(readFileSync(out, "utf8"));
    expect(merged.mcpServers["devops-filesystem"]).toBeDefined();
    expect(merged.mcpServers["devops-filesystem"].command).toBe("echo");
  });

  test("skill-install <source> --room --dry-run (single positional, name from basename)", async () => {
    const cfg = writeConfig();
    const wip = join(dir, "wip");
    await cli("skill-create", "demo", "--no-register", "--dir", wip, "--config", cfg);
    const src = join(wip, "demo");
    // Literal acceptance form: one positional source path, name derived from basename.
    const r = await cli("skill-install", src, "--room", "research", "--dry-run", "--config", cfg);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Would install: demo");
    expect(r.out).toContain(src);
    expect(r.out).toContain("room: research");
  });

  test("skill-install <name> <source> (two positionals) also works", async () => {
    const cfg = writeConfig();
    const wip = join(dir, "wip");
    await cli("skill-create", "demo2", "--no-register", "--dir", wip, "--config", cfg);
    const r = await cli("skill-install", "renamed", join(wip, "demo2"), "--room", "research", "--dry-run", "--config", cfg);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Would install: renamed");
  });

  test("skill-assign --auto completes with zero orphans remaining", async () => {
    const cfg = writeConfig();
    const r = await cli("skill-assign", "--auto", "--config", cfg);
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 orphan(s) remaining");
  });

  test("skills-list runs against an empty pool", async () => {
    const cfg = writeConfig();
    const r = await cli("skills-list", "--config", cfg);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no skills in pool");
  });

  test("skill-room-add grants an already-installed skill to a second room, additively", async () => {
    const cfg = writeConfig();
    const wip = join(dir, "wip3");
    await cli("skill-create", "shared-skill", "--no-register", "--dir", wip, "--config", cfg);
    const install1 = await cli("skill-install", join(wip, "shared-skill"), "--room", "research", "--config", cfg);
    expect(install1.code).toBe(0);

    const r = await cli("skill-room-add", "--skill", "shared-skill", "--room", "devops", "--config", cfg);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Granted 'shared-skill' in: devops");

    const toml = readFileSync(cfg, "utf8");
    expect(toml).toMatch(/\[skills\.rooms\.research\][\s\S]*?skills = \[.*"shared-skill".*\]/);
    expect(toml).toMatch(/\[skills\.rooms\.devops\][\s\S]*?skills = \[.*"shared-skill".*\]/);
  });

  test("skill-room-add is idempotent and reports no-op on a repeat grant", async () => {
    const cfg = writeConfig();
    const wip = join(dir, "wip4");
    await cli("skill-create", "solo-skill", "--no-register", "--dir", wip, "--config", cfg);
    await cli("skill-install", join(wip, "solo-skill"), "--room", "research", "--config", cfg);

    const first = await cli("skill-room-add", "--skill", "solo-skill", "--room", "research", "--config", cfg);
    expect(first.code).toBe(0);
    expect(first.out).toContain("already granted in 'research' — no change");
  });

  test("skill-room-add fails for a skill that isn't in the pool", async () => {
    const cfg = writeConfig();
    const r = await cli("skill-room-add", "--skill", "ghost", "--room", "research", "--config", cfg);
    expect(r.code).not.toBe(0);
  });

  // citty has no repeatable --room flag; a comma-separated value is the
  // documented way to target several rooms in one non-interactive call.
  test("skill-install --room a,b installs to the primary room and grants the rest", async () => {
    const cfg = writeConfig();
    const wip = join(dir, "wip-multi");
    await cli("skill-create", "multi-room-skill", "--no-register", "--dir", wip, "--config", cfg);
    const r = await cli(
      "skill-install",
      join(wip, "multi-room-skill"),
      "--room",
      "research,devops",
      "--config",
      cfg,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Routed to room: research");
    expect(r.out).toContain("Also granted in: devops");

    const toml = readFileSync(cfg, "utf8");
    expect(toml).toMatch(/\[skills\.rooms\.research\][\s\S]*?skills = \[.*"multi-room-skill".*\]/);
    expect(toml).toMatch(/\[skills\.rooms\.devops\][\s\S]*?skills = \[.*"multi-room-skill".*\]/);
  });

  test("skill-install --room a,b --dry-run reports the primary room and lists the rest as 'also', changing nothing", async () => {
    const cfg = writeConfig();
    const wip = join(dir, "wip-multi-dry");
    await cli("skill-create", "dry-multi", "--no-register", "--dir", wip, "--config", cfg);
    const r = await cli(
      "skill-install",
      join(wip, "dry-multi"),
      "--room",
      "research,devops",
      "--dry-run",
      "--config",
      cfg,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("room: research");
    expect(r.out).toContain("also: devops");
    expect(readFileSync(cfg, "utf8")).not.toContain("dry-multi");
  });

  // Also proves comma-list parsing tolerates a space after the comma and a
  // trailing comma (both silently trimmed/dropped, not treated as room
  // names in their own right).
  test("skill-room-add --room a,b grants multiple rooms in one call, with independent per-room idempotency", async () => {
    const cfg = writeConfig();
    const wip = join(dir, "wip-radd-multi");
    await cli("skill-create", "radd-multi", "--no-register", "--dir", wip, "--config", cfg);
    await cli("skill-install", join(wip, "radd-multi"), "--room", "devops", "--config", cfg);

    const r = await cli("skill-room-add", "--skill", "radd-multi", "--room", "devops, research,", "--config", cfg);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already granted in 'devops' — no change");
    expect(r.out).toContain("Granted 'radd-multi' in: research");

    const toml = readFileSync(cfg, "utf8");
    expect(toml).toMatch(/\[skills\.rooms\.research\][\s\S]*?skills = \[.*"radd-multi".*\]/);
  });
});

// ── Phase 5: agent integrations ───────────────────────────────────────────────

describe("install command (emit-don't-mutate)", () => {
  test("install --for cursor emits a JSON snippet and writes nothing", async () => {
    // Root the default-config home at the temp dir so the assertion is soak-safe
    // AND deterministic — emit resolves its default path from $HOME.
    const savedHome = process.env.HOME;
    process.env.HOME = dir;
    let r: { code: number; out: string };
    try {
      r = await cli("install", "--for", "cursor");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
    expect(r.code).toBe(0);
    expect(r.out).toContain('"mcpServers"');
    expect(r.out).toContain("harbor");
    expect(r.out).toContain("Re-run with --write");
    // Emit must mutate NOTHING: assert the default config path was not written.
    // (Asserting stdout alone would miss a stray write alongside the emit.)
    expect(existsSync(join(dir, ".cursor", "mcp.json"))).toBe(false);
  });

  test("install with no/invalid --for exits non-zero", async () => {
    const r = await cli("install", "--for", "nope");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Valid agents");
  });

  test("install --for codex --write --path creates the file (with no backup for a new file)", async () => {
    const target = join(dir, "codex.toml");
    const r = await cli("install", "--for", "codex", "--write", "--path", target);
    expect(r.code).toBe(0);
    expect(r.out).toContain("created");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("mcp_servers.harbor");
  });

  test("install --for gemini --write twice is idempotent (no change second time)", async () => {
    const target = join(dir, "gemini.json");
    await cli("install", "--for", "gemini", "--write", "--path", target);
    const second = await cli("install", "--for", "gemini", "--write", "--path", target);
    expect(second.out).toContain("already configured");
  });
});

describe("mcp-server command (subprocess stdio smoke)", () => {
  test("tools/list over stdio returns the harbor tool catalog", () => {
    const proc = Bun.spawnSync(["bun", CLI, "mcp-server", "--root", dir], {
      stdin: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    expect(out).toContain('"read_skill"');
    expect(out).toContain('"list_skills"');
    expect(out).toContain('"budget_status"');
  });

  test("initialize returns the pinned protocol version", () => {
    const proc = Bun.spawnSync(["bun", CLI, "mcp-server", "--root", dir], {
      stdin: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stdout.toString()).toContain("2025-06-18");
  });
});
