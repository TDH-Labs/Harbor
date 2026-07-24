#!/usr/bin/env bun
/**
 * cli.ts — Unified Harbor CLI (citty).
 *
 * Thin command wrappers over the Phase 1 core + Phase 2 integration modules.
 * Logic lives in the modules; this file only parses args and prints results.
 *
 * Downstream contract: the command tree ({@link main}) is exported so later
 * phases extend it (Phase 3 adds `spawn`/`budget`/`audit`, Phase 4 adds
 * `mcp-*`/`skill-*`, Phase 5 adds `install`/`mcp-server`). Every subcommand
 * accepts the global `--config` / `--root` selectors via {@link commonArgs}, and
 * resolves its {@link Environment} through {@link envFromArgs}.
 *
 * De-personalization: no path or room name is hardcoded — the environment is
 * always resolved from `--config`, `--root`, or `os.homedir()` defaults.
 */
import { type ArgsDef, type CommandDef, defineCommand, runMain } from "citty";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

import pkg from "../package.json" with { type: "json" };

import { Config } from "./config.ts";
import { CompactionEngine } from "./compaction.ts";
import { Environment } from "./env.ts";
import {
  auditDenialsToday,
  auditRead,
  createSession,
} from "./isolation.ts";
import { Scheduler, TaskState } from "./scheduler.ts";
import { SessionTracker, activeSession, listSessions } from "./session.ts";
import { runGenerate, fullSync, writeIfChanged } from "./sync.ts";
import { runBench, formatSummary, latestReport } from "./bench.ts";
import { startDashboard, DEFAULT_PORT } from "./dashboard.ts";
import { runForeground, startDaemon, stopDaemon, watcherStatus } from "./watch.ts";
import { spawn } from "./spawn.ts";
import { checkBudget, spendBudget, BudgetExceededError } from "./budget.ts";
import { gate, runWithGateContext, AccessDeniedError } from "./gate.ts";
import { audit } from "./audit.ts";
import { listSkills, generateRoomIndexes, findSkillDir } from "./skills.ts";
import {
  addServerToRoom,
  generateRoomConfig,
  generateRoomConfigs,
  mergeConfigs,
  removeServerFromRoom,
  roomsWithMcp,
  validateAllRooms,
  validateRoom,
} from "./mcp.ts";
import { scaffold } from "./skill-create.ts";
import { install } from "./skill-install.ts";
import { assignOrphans, assignOrphansAndReload, getOrphanSkills } from "./skill-assign.ts";
import { addSkillToAnotherRoom, listConfiguredRooms, roomsForSkill } from "./skill-room-add.ts";
import { update as updateSkill, removeSkill } from "./skill-update.ts";
import { canPrompt, confirmAction, pickRooms } from "./room-picker.ts";
import { AGENT_IDS, agentConfigPaths, applyConfig, emitSnippet, type AgentId } from "./install.ts";
import { analyzeIsolation, formatReport } from "./isolation-doctor.ts";
import { findSensitive, planPack, writePack } from "./buzz-pack.ts";
import {
  ChannelToolsError,
  defaultPolicyPath,
  listChannels,
  mapChannel,
  resolveChannelTools,
} from "./channel-tools.ts";
import { listGrants, saveGrant, purgeExpiredGrants, MAX_GRANT_SECONDS } from "./approval.ts";
import {
  describeSecrets,
  exportLines,
  getSecret,
  removeSecret,
  scanConfigs,
  setSecret,
  defaultHome,
} from "./secrets.ts";

// ── Environment resolution ────────────────────────────────────────────────────

/**
 * Print a value as pretty JSON with a BLOCKING write to fd 1.
 *
 * `console.log` on Bun writes to stdout asynchronously; when the output is a
 * pipe (as it is whenever a parent process — e.g. Buzz's desktop app reading
 * `harbor ... --json` via `Command::output()`) and the payload exceeds the OS
 * pipe buffer (~64 KB), the process can exit before the tail is flushed,
 * truncating the JSON mid-string. `writeSync` on the raw fd blocks until every
 * byte is handed to the kernel, so large `--json` outputs arrive whole. The
 * loop handles a short write (kernel accepting fewer bytes than offered).
 */
function printJson(value: unknown): void {
  const buf = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset, buf.length - offset);
    } catch (err) {
      // Bun marks a piped stdout non-blocking: once the ~64 KB pipe buffer
      // fills, writeSync throws EAGAIN instead of blocking. Retry until the
      // reader drains — dropping this catch is exactly what truncated large
      // `--json` payloads mid-string. The spin is bounded by output size.
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") continue;
      throw err;
    }
  }
}

export const commonArgs = {
  config: { type: "string", description: "Path to config.toml (its paths.home sets the root)" },
  root: { type: "string", description: "Environment root (uses built-in defaults)" },
} satisfies ArgsDef;

interface CommonArgs {
  config?: string;
  root?: string;
}

/** Resolve an Environment from the global `--config` / `--root` selectors. */
export function envFromArgs(args: CommonArgs): Environment {
  if (args.config) return Environment.load(args.config);
  if (args.root) return Environment.load(Config.defaults(), args.root);
  return Environment.load();
}

/** Resolve once a long-running command should exit (SIGINT/SIGTERM). */
function awaitInterrupt(): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

// ── sync / watch / dashboard ──────────────────────────────────────────────────

const syncCmd = defineCommand({
  meta: { name: "sync", description: "Generate beacons (and discover projects unless --generate-only)" },
  args: { ...commonArgs, "generate-only": { type: "boolean", description: "Regenerate beacons only" } },
  run({ args }) {
    const env = envFromArgs(args);
    if (args["generate-only"]) {
      const res = runGenerate(env);
      const n = Object.values(res.written).filter(Boolean).length;
      console.log(`sync: regenerated ${n} beacon file(s) under ${env.root}`);
    } else {
      const res = fullSync(env);
      console.log(`sync: ${res.projects.length} project(s), beacons regenerated under ${env.root}`);
    }
  },
});

const watchCmd = defineCommand({
  meta: { name: "watch", description: "Run the beacon watcher in the foreground" },
  args: { ...commonArgs, poll: { type: "boolean", description: "Force polling instead of native FSEvents" } },
  async run({ args }) {
    const env = envFromArgs(args);
    const handle = runForeground(env, args.poll ? { chokidarOptions: { usePolling: true } } : {});
    console.log(`watching ${env.watchPaths().length} path(s); Ctrl+C to stop`);
    await awaitInterrupt();
    await handle.stop();
  },
});

const startCmd = defineCommand({
  meta: { name: "start", description: "Start the watcher daemon (detached)" },
  args: { ...commonArgs },
  run({ args }) {
    const env = envFromArgs(args);
    const pid = startDaemon(env, import.meta.path);
    console.log(`watcher daemon running (pid ${pid})`);
  },
});

const stopCmd = defineCommand({
  meta: { name: "stop", description: "Stop the watcher daemon" },
  args: { ...commonArgs },
  run({ args }) {
    const stopped = stopDaemon(envFromArgs(args));
    console.log(stopped ? "watcher daemon stopped" : "no running watcher daemon");
  },
});

const dashboardCmd = defineCommand({
  meta: { name: "dashboard", description: "Serve the health dashboard" },
  args: { ...commonArgs, port: { type: "string", description: `Port (default ${DEFAULT_PORT})` } },
  async run({ args }) {
    const env = envFromArgs(args);
    const port = args.port ? Number.parseInt(args.port, 10) : DEFAULT_PORT;
    const server = startDashboard(env, { port });
    console.log(`dashboard: http://127.0.0.1:${server.port}`);
    await awaitInterrupt();
    server.stop();
  },
});

// ── bench ─────────────────────────────────────────────────────────────────────

const benchCmd = defineCommand({
  meta: { name: "bench", description: "Benchmark harness (control vs harbor)" },
  subCommands: {
    run: defineCommand({
      meta: { name: "run", description: "Run an interleaved benchmark" },
      args: {
        ...commonArgs,
        task: { type: "string", description: "Task name", default: "all" },
        runs: { type: "string", description: "Number of runs", default: "10" },
        agent: { type: "string", description: "Agent binary to benchmark" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const summary = runBench(env, {
          task: args.task,
          runs: Number.parseInt(args.runs, 10),
          ...(args.agent ? { agent: args.agent } : {}),
        });
        console.log(formatSummary(summary));
      },
    }),
    report: defineCommand({
      meta: { name: "report", description: "Show the latest benchmark report" },
      args: { ...commonArgs, json: { type: "boolean", description: "Output JSON" } },
      run({ args }) {
        const summary = latestReport(envFromArgs(args));
        if (!summary) {
          console.log("no benchmark results found");
          return;
        }
        if (args.json) printJson(summary);
        else console.log(formatSummary(summary));
      },
    }),
  },
});

// ── scheduler ─────────────────────────────────────────────────────────────────

const schedulerCmd = defineCommand({
  meta: { name: "scheduler", description: "Priority-queue task scheduler" },
  subCommands: {
    stats: defineCommand({
      meta: { name: "stats", description: "Show task counts by state and per-room budgets" },
      args: { ...commonArgs },
      run({ args }) {
        const s = new Scheduler({ env: envFromArgs(args) });
        try {
          const stats = s.queueStats();
          console.log("tasks by state:");
          for (const [state, n] of Object.entries(stats.counts)) console.log(`  ${state}: ${n}`);
          for (const [room, b] of Object.entries(stats.budgets)) {
            console.log(`  budget[${room}]: ${b.used}/${b.limit} (remaining ${b.remaining})`);
          }
        } finally {
          s.close();
        }
      },
    }),
    submit: defineCommand({
      meta: { name: "submit", description: "Queue a task" },
      args: {
        ...commonArgs,
        name: { type: "positional", required: true, description: "Task name" },
        room: { type: "string", description: "Room", default: "" },
        cmd: { type: "string", description: "Command to run" },
        "task-args": { type: "string", description: "Space-separated command args" },
        priority: { type: "string", description: "Priority", default: "0" },
        "max-tokens": { type: "string", description: "Token budget", default: "0" },
        deadline: { type: "string", description: "Deadline (seconds from now)" },
        recurring: { type: "string", description: "Recurring interval (seconds)", default: "0" },
      },
      run({ args }) {
        const s = new Scheduler({ env: envFromArgs(args) });
        try {
          const id = s.submit(args.name, {
            room: args.room,
            command: args.cmd ?? "",
            args: args["task-args"] ? args["task-args"].split(" ").filter(Boolean) : [],
            priority: Number.parseInt(args.priority, 10),
            tokensBudget: Number.parseInt(args["max-tokens"], 10),
            deadline: args.deadline ? Date.now() / 1000 + Number.parseInt(args.deadline, 10) : null,
            recurringInterval: Number.parseInt(args.recurring, 10),
          });
          console.log(`queued task ${id}`);
        } finally {
          s.close();
        }
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List tasks (optionally by state)" },
      args: { ...commonArgs, state: { type: "positional", required: false, description: "State filter" } },
      run({ args }) {
        const s = new Scheduler({ env: envFromArgs(args) });
        try {
          for (const t of s.listTasks(args.state)) {
            console.log(`${t.id}  ${t.state.padEnd(10)} p${t.priority}  ${t.room}/${t.name}`);
          }
        } finally {
          s.close();
        }
      },
    }),
    cancel: defineCommand({
      meta: { name: "cancel", description: "Cancel a queued task" },
      args: { ...commonArgs, "task-id": { type: "positional", required: true, description: "Task id" } },
      run({ args }) {
        const s = new Scheduler({ env: envFromArgs(args) });
        try {
          console.log(s.cancel(args["task-id"]) ? "cancelled" : "no such cancellable task");
        } finally {
          s.close();
        }
      },
    }),
    "run-once": defineCommand({
      meta: { name: "run-once", description: "Process at most one task" },
      args: { ...commonArgs },
      run({ args }) {
        const s = new Scheduler({ env: envFromArgs(args) });
        try {
          console.log(`processed ${s.runOnce()} task(s)`);
        } finally {
          s.close();
        }
      },
    }),
    daemon: defineCommand({
      meta: { name: "daemon", description: "Run the scheduler loop until interrupted" },
      args: { ...commonArgs, interval: { type: "string", description: "Idle poll seconds", default: "5" } },
      async run({ args }) {
        const s = new Scheduler({ env: envFromArgs(args) });
        const intervalMs = Number.parseInt(args.interval, 10) * 1000;
        let stop = false;
        const onSig = () => (stop = true);
        process.on("SIGINT", onSig);
        process.on("SIGTERM", onSig);
        console.log("scheduler daemon running; Ctrl+C to stop");
        while (!stop) {
          if (s.runOnce() === 0) await Bun.sleep(intervalMs);
        }
        s.close();
      },
    }),
  },
});

// ── compaction ────────────────────────────────────────────────────────────────

const compactionArgs = {
  ...commonArgs,
  "session-id": { type: "string", description: "Session id", default: "default" },
  room: { type: "string", description: "Room", default: "" },
} satisfies ArgsDef;

function compactionEngine(args: CommonArgs & { "session-id": string; room: string }): CompactionEngine {
  return new CompactionEngine({ env: envFromArgs(args), sessionId: args["session-id"], room: args.room });
}

const compactionCmd = defineCommand({
  meta: { name: "compaction", description: "Context compaction + archive" },
  subCommands: {
    stats: defineCommand({
      meta: { name: "stats", description: "Budget usage + archive size" },
      args: compactionArgs,
      run({ args }) {
        const e = compactionEngine(args);
        try {
          const s = e.stats();
          console.log(
            `tokens ${s.tokensUsed}/${s.tokenLimit} (${s.budgetPercent}%) · items ${s.loadedItems} · archived ${s.archivedCount}`,
          );
        } finally {
          e.close();
        }
      },
    }),
    archive: defineCommand({
      meta: { name: "archive", description: "Evict a context entry to the archive" },
      args: { ...compactionArgs, key: { type: "positional", required: true, description: "Context key" } },
      run({ args }) {
        const e = compactionEngine(args);
        try {
          console.log(e.evict(args.key) ? `archived ${args.key}` : `not loaded: ${args.key}`);
        } finally {
          e.close();
        }
      },
    }),
    retrieve: defineCommand({
      meta: { name: "retrieve", description: "Fetch archived content for a key" },
      args: { ...compactionArgs, key: { type: "positional", required: true, description: "Context key" } },
      run({ args }) {
        const e = compactionEngine(args);
        try {
          const content = e.retrieve(args.key);
          console.log(content === null ? `no archive for ${args.key}` : content.slice(0, 1000));
        } finally {
          e.close();
        }
      },
    }),
    "list-archive": defineCommand({
      meta: { name: "list-archive", description: "List archived entries" },
      args: compactionArgs,
      run({ args }) {
        const e = compactionEngine(args);
        try {
          for (const a of e.listArchive()) console.log(`${a.key}  ${a.tokens} tokens  ${a.tier}`);
        } finally {
          e.close();
        }
      },
    }),
  },
});

// ── isolation ─────────────────────────────────────────────────────────────────

const isolationCmd = defineCommand({
  meta: { name: "isolation", description: "Capability / room gating + audit" },
  subCommands: {
    doctor: defineCommand({
      meta: {
        name: "doctor",
        description: "Report the current isolation posture and what would break under real isolation (READ ONLY)",
      },
      args: { ...commonArgs, json: { type: "boolean", description: "Emit the raw report as JSON" } },
      run({ args }) {
        const report = analyzeIsolation(envFromArgs(args));
        if (args.json) printJson(report);
        else console.log(formatReport(report));
      },
    }),
    check: defineCommand({
      meta: { name: "check", description: "Check whether a room grants a capability" },
      args: {
        ...commonArgs,
        room: { type: "positional", required: true, description: "Room" },
        capability: { type: "positional", required: true, description: "Capability" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const session = createSession({ room: args.room, env });
        const allowed = session.has(args.capability);
        console.log(`${allowed ? "ALLOW" : "DENY"}  room=${args.room} capability=${args.capability}`);
        console.log(`  capabilities: ${[...session.capabilities].sort().join(", ")}`);
      },
    }),
    rooms: defineCommand({
      meta: { name: "rooms", description: "List rooms and their capabilities" },
      args: { ...commonArgs },
      run({ args }) {
        const env = envFromArgs(args);
        const rooms = Object.keys(env.config.roomSkills);
        if (rooms.length === 0) console.log("(no rooms configured)");
        for (const room of rooms) {
          console.log(`${room}: ${env.config.roomCapabilities(room).join(", ")}`);
        }
      },
    }),
    audit: defineCommand({
      meta: { name: "audit", description: "Show recent audit entries" },
      args: {
        ...commonArgs,
        room: { type: "string", description: "Filter by room" },
        limit: { type: "string", description: "Max entries", default: "50" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const entries = auditRead(env, {
          ...(args.room ? { room: args.room } : {}),
          limit: Number.parseInt(args.limit, 10),
        });
        for (const e of entries) {
          console.log(`${e.decision.padEnd(7)} ${e.room}/${e.event} ${e.capability} ${e.resource}`);
        }
      },
    }),
    denials: defineCommand({
      meta: { name: "denials", description: "Count today's denials" },
      args: { ...commonArgs, room: { type: "string", description: "Filter by room" } },
      run({ args }) {
        const env = envFromArgs(args);
        console.log(`${auditDenialsToday(env, args.room)} denial(s) today${args.room ? ` in ${args.room}` : ""}`);
      },
    }),
  },
});

// ── session ───────────────────────────────────────────────────────────────────

const sessionCmd = defineCommand({
  meta: { name: "session", description: "Agent session tracking" },
  subCommands: {
    start: defineCommand({
      meta: { name: "start", description: "Start a session" },
      args: {
        ...commonArgs,
        room: { type: "positional", required: true, description: "Room" },
        budget: { type: "positional", required: false, description: "Token budget" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const tracker = new SessionTracker({ env });
        const state = tracker.start(args.room, args.budget ? { budget: Number.parseInt(args.budget, 10) } : {});
        console.log(`session ${state.sessionId} started in ${state.room} (budget ${state.tokenLimit})`);
      },
    }),
    track: defineCommand({
      meta: { name: "track", description: "Record a context-load event on the active session" },
      args: {
        ...commonArgs,
        key: { type: "positional", required: true, description: "Context key" },
        tokens: { type: "positional", required: true, description: "Token count" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const active = activeSession(env);
        if (!active) {
          console.log("no active session");
          return;
        }
        const tracker = new SessionTracker({ env, sessionId: active.sessionId });
        tracker.track(args.key, Number.parseInt(args.tokens, 10));
        console.log(`tracked ${args.tokens} tokens for ${args.key}`);
      },
    }),
    end: defineCommand({
      meta: { name: "end", description: "End the active session" },
      args: {
        ...commonArgs,
        status: { type: "positional", required: false, description: "End status", default: "completed" },
        summary: { type: "positional", required: false, description: "Summary", default: "" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const active = activeSession(env);
        if (!active) {
          console.log("no active session");
          return;
        }
        const tracker = new SessionTracker({ env, sessionId: active.sessionId });
        tracker.end(args.status, args.summary);
        console.log(`session ${active.sessionId} ended (${args.status})`);
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List rolled-up sessions" },
      args: { ...commonArgs, room: { type: "positional", required: false, description: "Filter by room" } },
      run({ args }) {
        const env = envFromArgs(args);
        for (const s of listSessions(env, args.room ? { room: args.room } : {})) {
          console.log(`${s.sessionId}  ${s.room}  ${s.tokensUsed}/${s.tokenLimit}  ${s.status}`);
        }
      },
    }),
    active: defineCommand({
      meta: { name: "active", description: "Show the active session" },
      args: { ...commonArgs },
      run({ args }) {
        const active = activeSession(envFromArgs(args));
        console.log(active ? `${active.sessionId}  ${active.room}  ${active.status}` : "no active session");
      },
    }),
  },
});

// ── check / init ──────────────────────────────────────────────────────────────

const checkCmd = defineCommand({
  meta: { name: "check", description: "Read-only health check of the environment" },
  args: { ...commonArgs },
  run({ args }) {
    const env = envFromArgs(args);
    const ok = (m: string) => console.log(`ok   ${m}`);
    const warn = (m: string) => console.log(`warn ${m}`);
    ok(`config schema ${env.config.schemaVersion}, root ${env.root}`);
    if (existsSync(env.agentMap)) ok("agent_map.md present");
    else warn("agent_map.md missing (run `harbor sync` or `harbor init`)");
    for (const target of env.config.homeBeaconTargets) {
      const p = `${env.root}/${target}`;
      if (!existsSync(p)) warn(`${target} missing`);
      else if (readFileSync(p, "utf8").includes("<!-- agent-env:sync -->")) ok(`${target} fresh`);
      else warn(`${target} present but unstamped (overwritten by another tool?)`);
    }
    const w = watcherStatus(env);
    console.log(`${w.running ? "ok  " : "warn"} watcher ${w.running ? `running (pid ${w.pid})` : "not running"}`);
  },
});

const initCmd = defineCommand({
  meta: { name: "init", description: "Initialize the environment (seed agent_map.md + beacons)" },
  args: { ...commonArgs },
  run({ args }) {
    const env = envFromArgs(args);
    const seed = [
      "# Agent Map",
      "",
      "## Rooms",
      "",
      "| Room | Path | Purpose |",
      "|------|------|---------|",
      "",
      "## Projects",
      "",
      "| Project | Path | Status |",
      "|---------|------|--------|",
      "",
    ].join("\n");
    const wrote = !existsSync(env.agentMap) && writeIfChanged(env.agentMap, seed);
    runGenerate(env);
    console.log(`init: ${wrote ? "wrote" : "kept"} agent_map.md, generated beacons under ${env.root}`);
  },
});

/**
 * The bundled `extending-harbor` skill, seeded into the pool on `setup`. It is
 * the full step-by-step the beacon's always-read guardrail block points at:
 * how to add/route skills, add MCP servers, and reconcile — and the
 * anti-patterns (npx-global install, manual pool dumps, cross-agent symlinks)
 * that contaminate a Harbor environment. Bundling it as a string keeps the
 * package self-contained (no extra files in the npm allowlist) and makes every
 * `harbor setup` produce a machine that can teach an agent how to extend it.
 */
export const EXTENDING_HARBOR_SKILL = `---
name: extending-harbor
description: How to correctly add skills, MCP servers, and tools to a machine running Harbor. Read this before installing or routing anything — it prevents polluting the shared skill pool or leaking skills across agents.
---

# Extending a Harbor Environment

This machine runs Harbor, an agent control plane. Skills, MCP servers, and rooms
are managed through the \`harbor\` CLI. Going around it — \`npx skills add -g\`,
copying files into the pool, symlinking into an agent's auto-load directory —
breaks Harbor's routing and leaks one skill into every agent. Always use the
commands below.

## Add a skill

    harbor skill-install <source> --room <room>

\`<source>\` is a directory or a SKILL.md file. \`--room\` routes it so only that
room's agents see it; omit it to let Harbor auto-route by content.

To scaffold a brand-new skill first (TDD harness, placeholder content), fill
it in, then register it once ready:

    harbor skill-create <name> --no-register --dir <working-dir>
    # ...edit <working-dir>/<name>/SKILL.md...
    harbor skill-install <working-dir>/<name> --room <room>

Passing \`--room\` to \`skill-create\` WITHOUT \`--no-register\` copies the
placeholder into the pool and routes it immediately — \`--dir\` only changes
*where the working copy is written*, it does not stage or defer that. Always
pair \`--dir\` with \`--no-register\` for a genuine scaffold-then-fill workflow.

To overwrite an already-registered skill's content in place (e.g. filling in
a scaffold you registered too early):

    harbor skill-update <name> --source <file-or-dir>

To unregister/delete a skill:

    harbor skill-remove <name> --room <room>   # unregister from one room only
    harbor skill-remove <name>                 # unregister everywhere + delete pool files

NEVER do any of these:
- \`npx skills add -g <pkg>\` — dumps the skill flat in the pool and symlinks it
  into every agent's auto-load dir (the exact contamination this skill prevents).
- Manually \`cp\`/\`mv\` a skill into the pool (\`~/.agents/skills/\`).
- Hand-symlink a skill into an agent's directory.

## Route an existing pool skill to a room

    harbor skill-assign                 # report suggested routing
    harbor skill-assign --auto          # apply best-match routing
    harbor skill-assign --room <room>   # assign orphans to one room

If the room isn't in config yet but exists on disk
(\`~/rooms/<room>/room_rules.md\`), these create its config entry automatically.

## Wire Harbor's OWN meta-server into an agent

    harbor install --for <agent>          # print the config block (writes nothing)
    harbor install --for <agent> --write  # apply it (backs up the existing file)

Supported <agent>: claude-code, cursor, opencode, codex, gemini, goose,
antigravity, pi, orchestrator. Each gets its own verified env-substitution
dialect — Antigravity is a DIFFERENT product from the Gemini CLI and has its
own config file. This wires Harbor's own \`read_skill\`/\`list_skills\`/etc. server —
it does NOT add a third-party MCP server (AgentPhone, Composio, ...); there is
no \`--command\`/\`--args\`/\`--env\` path through \`install\` for that.

## Add a THIRD-PARTY MCP server to a room

    harbor mcp-add --room <room> --name <name> --command <cmd> \\
      [--args a,b,c] [--env KEY=VALUE,KEY2=$VAR2]
    harbor mcp-gen --room <room>   # regenerate that room's .room-mcp.json

This is the sanctioned command for the thing \`harbor install\` above does NOT
do — it writes \`[[skills.rooms.<room>.mcp.servers]]\` structurally. Never hand-
edit that array in config.toml.

## After ANY change

    harbor sync

Regenerates the beacons (AGENTS.md / CLAUDE.md / .cursorrules) and every room's
skills_index.md so the environment reflects what you changed. Skipping this
leaves agents reading stale routing.

## Rules

- Don't hand-edit \`config.toml\` when a command owns the section (skill-install,
  skill-assign, skill-remove, mcp-add, install all write it structurally).
- Don't stop or fight the watcher; it owns the beacons and re-syncs on change.
- Verify your change landed: \`harbor skills-list --room <room>\` or \`harbor check\`.
`;

/**
 * Seed the bundled {@link EXTENDING_HARBOR_SKILL} into the pool if absent.
 * Idempotent — never overwrites an existing copy (an operator may have edited
 * it). Returns true when it wrote the file.
 */
export function seedExtendingHarborSkill(env: Environment): boolean {
  const p = join(env.skillsDir, "extending-harbor", "SKILL.md");
  if (existsSync(p)) return false;
  mkdirSync(join(env.skillsDir, "extending-harbor"), { recursive: true });
  writeFileSync(p, EXTENDING_HARBOR_SKILL);
  return true;
}

/**
 * Build the standard directory skeleton an Environment derives from config.
 * Mirrors the Python prototype's `create_tree` (cli.py:create_tree) — the
 * five-layer tree plus the state/skills/logs/sessions/archive dirs every core
 * module writes into. `mkdir -p`, so it is idempotent and safe to re-run.
 * Returns the directories that did not exist before this call.
 */
export function setupTree(env: Environment): string[] {
  const dirs = [
    env.root,
    env.workspace,
    env.rooms,
    env.dataDir,
    env.stateDir,
    env.skillsDir,
    env.logsDir,
    env.sessionsDir,
    env.archiveDir,
  ];
  const created: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) created.push(d);
    mkdirSync(d, { recursive: true });
  }
  return created;
}

const setupCmd = defineCommand({
  meta: { name: "setup", description: "Build the directory tree from config and generate beacons" },
  args: { ...commonArgs },
  run({ args }) {
    const env = envFromArgs(args);
    const created = setupTree(env);
    const seededSkill = seedExtendingHarborSkill(env);
    // Seed agent_map.md if absent (init may already have written a richer one),
    // then generate beacons so a freshly-built tree is immediately usable.
    const seed = [
      "# Agent Map",
      "",
      "## Rooms",
      "",
      "| Room | Path | Purpose |",
      "|------|------|---------|",
      "",
      "## Projects",
      "",
      "| Project | Path | Status |",
      "|---------|------|--------|",
      "",
    ].join("\n");
    const wroteMap = !existsSync(env.agentMap) && writeIfChanged(env.agentMap, seed);
    runGenerate(env);
    console.log(
      `setup: created ${created.length} dir(s) under ${env.root}` +
        `${wroteMap ? ", seeded agent_map.md" : ""}` +
        `${seededSkill ? ", seeded extending-harbor skill" : ""}, generated beacons`,
    );
  },
});

// ── hypervisor: spawn / budget / gate / audit (Phase 3) ─────────────────────────

const spawnCmd = defineCommand({
  meta: { name: "spawn", description: "Spawn a Harbor-owned child process (room, budget, timeout)" },
  args: {
    ...commonArgs,
    room: { type: "string", description: "Room", default: "" },
    budget: { type: "string", description: "Token budget" },
    timeout: { type: "string", description: "Timeout (ms)" },
    "allow-path": { type: "string", description: "Allowed paths (':'-separated logical sandbox)" },
  },
  async run({ args }) {
    const env = envFromArgs(args);
    const rest = ((args as unknown as { _?: string[] })._ ?? []).filter(Boolean);
    const command = rest[0];
    if (!command) {
      console.log("usage: harbor spawn [--room R] [--budget N] [--timeout MS] -- <command> [args...]");
      return;
    }
    const child = spawn(command, rest.slice(1), {
      harborEnv: env,
      ...(args.room ? { room: args.room } : {}),
      ...(args.budget ? { budget: Number.parseInt(args.budget, 10) } : {}),
      ...(args.timeout ? { timeout: Number.parseInt(args.timeout, 10) } : {}),
      ...(args["allow-path"] ? { allowedPaths: args["allow-path"].split(":").filter(Boolean) } : {}),
    });
    const code = await child.exited;
    if (child.stdout) {
      const out = (await new Response(child.stdout as ReadableStream).text()).trim();
      if (out) console.log(out);
    }
    console.log(
      `spawn: pid ${child.pid} room=${child.room} session=${child.sessionId} ` +
        `exit=${code}${child.timedOut ? " (timeout)" : ""} tokens=${child.tokensUsed}/${child.budget}`,
    );
  },
});

const budgetCmd = defineCommand({
  meta: { name: "budget", description: "In-process token budget check / spend" },
  subCommands: {
    check: defineCommand({
      meta: { name: "check", description: "Check whether tokens can be spent (no mutation)" },
      args: {
        ...commonArgs,
        "session-id": { type: "positional", required: true, description: "Session id" },
        key: { type: "positional", required: true, description: "Context key" },
        tokens: { type: "positional", required: true, description: "Token count" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const r = checkBudget(args["session-id"], args.key, Number.parseInt(args.tokens, 10), { env });
        console.log(`${r.ok ? "OK" : "DENY"}  ${r.used}/${r.limit} used, ${r.remaining} remaining${r.reason ? ` — ${r.reason}` : ""}`);
      },
    }),
    spend: defineCommand({
      meta: { name: "spend", description: "Debit tokens against a session budget" },
      args: {
        ...commonArgs,
        "session-id": { type: "positional", required: true, description: "Session id" },
        key: { type: "positional", required: true, description: "Context key" },
        tokens: { type: "positional", required: true, description: "Token count" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        try {
          const r = spendBudget(args["session-id"], args.key, Number.parseInt(args.tokens, 10), { env });
          console.log(`spent: ${r.used}/${r.limit} used, ${r.remaining} remaining`);
        } catch (err) {
          if (err instanceof BudgetExceededError) console.log(`DENY  ${err.message}`);
          else throw err;
        }
      },
    }),
  },
});

const gateCmd = defineCommand({
  meta: { name: "gate", description: "Check whether a room may run a tool (room-gated capability check)" },
  args: {
    ...commonArgs,
    room: { type: "positional", required: true, description: "Room" },
    tool: { type: "positional", required: true, description: "Tool / capability name" },
    resource: { type: "positional", required: false, description: "Resource (e.g. skill name)" },
  },
  async run({ args }) {
    const env = envFromArgs(args);
    const session = createSession({ room: args.room, env });
    try {
      await runWithGateContext({ env, session }, () =>
        gate(args.tool, async (_resource: string) => true)(args.resource ?? ""),
      );
      console.log(`ALLOW  room=${args.room} tool=${args.tool}${args.resource ? ` resource=${args.resource}` : ""}`);
    } catch (err) {
      if (err instanceof AccessDeniedError) console.log(`DENY  ${err.message}`);
      else throw err;
    }
  },
});

const auditCmd = defineCommand({
  meta: { name: "audit", description: "Hypervisor audit trail (denials / allowances)" },
  subCommands: {
    recent: defineCommand({
      meta: { name: "recent", description: "Recent audit entries" },
      args: {
        ...commonArgs,
        room: { type: "string", description: "Filter by room" },
        limit: { type: "string", description: "Max entries", default: "20" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const entries = audit.recent({
          env,
          ...(args.room ? { room: args.room } : {}),
          limit: Number.parseInt(args.limit, 10),
        });
        for (const e of entries) {
          console.log(`${e.decision.padEnd(7)} ${e.room}/${e.event} ${e.capability} ${e.resource}`);
        }
      },
    }),
    denials: defineCommand({
      meta: { name: "denials", description: "Count today's denials" },
      args: { ...commonArgs, room: { type: "string", description: "Filter by room" } },
      run({ args }) {
        const env = envFromArgs(args);
        const n = audit.denialsToday(args.room, { env });
        console.log(`${n} denial(s) today${args.room ? ` in ${args.room}` : ""}`);
      },
    }),
  },
});

// ── Skill / MCP tooling ─────────────────────────────────────────────────────--

const skillsListCmd = defineCommand({
  meta: { name: "skills-list", description: "List pool skills with room assignments" },
  args: {
    ...commonArgs,
    room: { type: "string", description: "Filter to one room" },
    json: { type: "boolean", description: "Emit JSON (name/room/description per skill)" },
  },
  run({ args }) {
    const env = envFromArgs(args);
    const skills = listSkills(env, args.room);
    if (args.json) {
      printJson(skills);
      return;
    }
    if (skills.length === 0) {
      console.log(args.room ? `(no skills in room ${args.room})` : "(no skills in pool)");
      return;
    }
    for (const s of skills) {
      console.log(`${s.name.padEnd(28)} ${s.room.padEnd(16)} ${s.description}`);
    }
    console.log(`\n${skills.length} skill(s)`);
  },
});

const mcpCheckCmd = defineCommand({
  meta: { name: "mcp-check", description: "Validate MCP servers (command exists, env vars set)" },
  args: {
    ...commonArgs,
    room: { type: "string", description: "Check a single room" },
    connectivity: { type: "boolean", description: "Also run a brief process-start test" },
  },
  async run({ args }) {
    const env = envFromArgs(args);
    const opts = { connectivity: Boolean(args.connectivity) };
    const rooms = args.room ? [await validateRoom(env, args.room, opts)] : await validateAllRooms(env, opts);
    let allOk = true;
    for (const r of rooms) {
      if (r.status === "no_servers") {
        console.log(`  ${r.room}: no MCP servers configured`);
        continue;
      }
      for (const s of r.servers) {
        console.log(`  ${s.ok ? "✓" : "✗"} ${r.room}/${s.server} (${s.command} ${s.args.join(" ")})`);
        for (const c of s.checks) {
          if (!c.ok || !s.ok) console.log(`      ${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`);
        }
        if (!s.ok) allOk = false;
      }
    }
    if (!allOk) process.exitCode = 1;
    else console.log("\n✅ All MCP servers OK");
  },
});

const mcpAddCmd = defineCommand({
  meta: {
    name: "mcp-add",
    description: "Add or update a third-party MCP server for a room (the structural alternative to hand-editing config.toml)",
  },
  args: {
    ...commonArgs,
    room: { type: "string", description: "Target room (existing in config, or on disk — see skill-room-add)" },
    name: { type: "string", description: "Server entry name" },
    command: { type: "string", description: "Server command" },
    args: { type: "string", description: "Comma-separated command args" },
    env: { type: "string", description: "Comma-separated KEY=VALUE env vars" },
  },
  run({ args }) {
    const env = envFromArgs(args);
    const room = args.room;
    const name = args.name;
    const command = args.command;
    if (!room || !name || !command) {
      console.error("mcp-add: --room, --name, and --command are all required");
      process.exitCode = 1;
      return;
    }
    const serverArgs = parseCommaList(args.args);
    const envVars = parseEnvPairs(args.env);

    let result;
    try {
      result = addServerToRoom(env, room, {
        name,
        command,
        ...(serverArgs.length > 0 ? { args: serverArgs } : {}),
        ...(Object.keys(envVars).length > 0 ? { env: envVars } : {}),
      });
    } catch (err) {
      console.error(`mcp-add: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    if (!result.changed) {
      console.log(`'${name}' is already configured in '${room}' with this exact definition — no change.`);
    } else {
      console.log(`✓ Added '${name}' to room: ${room}${result.roomCreated ? " (room created)" : ""}`);
      console.log(`  Run 'harbor mcp-gen --room ${room}' to regenerate its .room-mcp.json.`);
    }
  },
});

const mcpRemoveCmd = defineCommand({
  meta: {
    name: "mcp-remove",
    description: "Remove an MCP server from a room (structural inverse of mcp-add)",
  },
  args: {
    ...commonArgs,
    room: { type: "string", description: "Room to remove the server from" },
    name: { type: "string", description: "Server entry name to remove" },
  },
  run({ args }) {
    const env = envFromArgs(args);
    const room = args.room;
    const name = args.name;
    if (!room || !name) {
      console.error("mcp-remove: --room and --name are both required");
      process.exitCode = 1;
      return;
    }
    let result;
    try {
      result = removeServerFromRoom(env, room, name);
    } catch (err) {
      console.error(`mcp-remove: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      result.changed
        ? `✓ Removed '${name}' from room: ${room}`
        : `'${name}' is not configured in '${room}' — nothing to remove.`,
    );
  },
});

const mcpGenCmd = defineCommand({
  meta: { name: "mcp-gen", description: "Generate per-room .room-mcp.json configs" },
  args: { ...commonArgs, room: { type: "string", description: "Generate for one room" } },
  run({ args }) {
    const env = envFromArgs(args);
    if (args.room) {
      const p = generateRoomConfig(env, args.room);
      console.log(p ? `  ${args.room}: MCP servers → ${p}` : `  ${args.room}: no MCP servers configured`);
      return;
    }
    const results = generateRoomConfigs(env);
    for (const [room, p] of Object.entries(results)) {
      console.log(p ? `  ${room}: MCP servers → ${p}` : `  ${room}: no MCP servers configured`);
    }
  },
});

const mcpMergeCmd = defineCommand({
  meta: { name: "mcp-merge", description: "Merge several rooms' MCP servers into one config" },
  args: {
    ...commonArgs,
    output: { type: "string", alias: "o", description: "Write merged JSON to this path" },
    "no-prefix": { type: "boolean", description: "Keep bare server names (prefix only on collision)" },
    list: { type: "boolean", description: "List rooms that declare MCP servers" },
  },
  run({ args }) {
    const env = envFromArgs(args);
    if (args.list) {
      console.log("Rooms with MCP servers:");
      for (const r of roomsWithMcp(env)) console.log(`  ${r}`);
      return;
    }
    // citty collects bare positionals (the room names) on args._.
    const positionals = ((args as Record<string, unknown>)._ as string[] | undefined) ?? [];
    const selected = positionals.length > 0 ? positionals : roomsWithMcp(env);
    if (selected.length === 0) {
      console.log("No rooms with MCP servers found");
      process.exitCode = 1;
      return;
    }
    const merged = mergeConfigs(env, selected, {
      prefix: !args["no-prefix"],
      ...(args.output ? { output: args.output } : {}),
    });
    if (args.output) {
      console.log(`Merged MCP config for ${selected.length} room(s) → ${args.output}`);
    } else {
      printJson(merged);
    }
  },
});

const skillCreateCmd = defineCommand({
  meta: { name: "skill-create", description: "Scaffold a new skill with a TDD harness" },
  args: {
    ...commonArgs,
    name: { type: "positional", required: true, description: "Skill slug" },
    room: {
      type: "string",
      description: "Target room — passing this registers the skill (copies into the pool + routes) immediately, unless --no-register",
    },
    description: { type: "string", description: "One-line description" },
    "no-register": {
      type: "boolean",
      description: "Scaffold only — never copy into the pool, even with --room. Follow up with skill-install once the content is ready",
    },
    dir: {
      type: "string",
      description:
        "Working copy location (default: <data dir>/skills-in-progress). Does NOT defer or stage registration — " +
        "that's controlled solely by --room/--no-register; use --no-register if you want to edit here before anything touches the pool",
    },
  },
  run({ args }) {
    const env = envFromArgs(args);
    const res = scaffold(env, args.name, {
      ...(args.room ? { room: args.room } : {}),
      ...(args.description ? { description: args.description } : {}),
      register: !args["no-register"] && Boolean(args.room),
      ...(args.dir ? { workDir: args.dir } : {}),
    });
    for (const f of res.files) console.log(`  created ${f}`);
    console.log(`\nScaffolded at ${res.skillDir}`);
    console.log(res.registered ? `Registered to room: ${res.room}` : "Not registered (--no-register or no --room).");
  },
});

// citty's ArgType has no repeatable/array flag — a re-declared `--room` just
// overwrites the previous value, it doesn't accumulate. Multi-room selection
// on the non-interactive path is exposed instead as a single comma-separated
// `--room a,b,c`, shared by skill-install and skill-room-add below. Splitting
// on `,` can never fragment a legitimate room name: isValidRoomName (see
// config-edit.ts) already forbids commas in a valid slug, and every value
// here is validated downstream by install()/addSkillToAnotherRoom() before
// it touches config or disk.
function parseCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/** `--room` is the one caller with its own name for this same parsing. */
const parseRooms = parseCommaList;

/** Parse `--env KEY1=VAL1,KEY2=VAL2` into a plain object. Segments without a
 * `=` (or with an empty key) are dropped rather than producing a bad entry. */
function parseEnvPairs(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of parseCommaList(value)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return out;
}

const skillInstallCmd = defineCommand({
  meta: { name: "skill-install", description: "Install a skill into the pool and route it to a room" },
  args: {
    ...commonArgs,
    // Positionals are read from args._ (citty mis-parses multiple declared
    // positionals). Forms: `<source>` (name = basename) or `<name> <source>`.
    name: { type: "string", description: "Skill slug (else derived from the source path)" },
    source: { type: "string", description: "Source directory or SKILL.md file" },
    room: { type: "string", description: "Target room, or comma-separated for several (first is primary). Else prompts interactively (or auto-routes by score with --auto / non-interactively)" },
    auto: { type: "boolean", description: "Auto-route by score, no prompt (for scripting/CI)" },
    "dry-run": { type: "boolean", description: "Report source/destination/room only" },
  },
  async run({ args }) {
    const env = envFromArgs(args);
    const positionals = ((args as Record<string, unknown>)._ as string[] | undefined) ?? [];
    let name = args.name;
    let source = args.source;
    if (!source) {
      // <name> <source> when two positionals; <source> alone otherwise.
      if (positionals.length >= 2) {
        name = name ?? positionals[0];
        source = positionals[1];
      } else if (positionals.length === 1) {
        source = positionals[0];
      }
    }
    if (!source) {
      console.error("skill-install: a source path is required");
      process.exitCode = 1;
      return;
    }
    name = name ?? basename(source.replace(/\/+$/, "")).replace(/\.md$/, "");
    const dryRun = Boolean(args["dry-run"]);
    const explicitRooms = parseRooms(args.room);

    // Interactive room picker: only when nothing already decided the room and
    // a human is actually there to ask. --room/--auto/--dry-run/non-TTY all
    // keep the prior silent single-room behavior unchanged (never hang a
    // scripted/CI/piped invocation waiting for input that can't arrive).
    if (explicitRooms.length === 0 && !args.auto && !dryRun && canPrompt()) {
      const rooms = listConfiguredRooms(env);
      // No configured rooms to choose from yet (e.g. the very first install):
      // pickRooms([]) returns [] with no prompt shown, which used to hit the
      // "at least one room is required" error below and block the install
      // entirely. Fall through instead to the same default-room path the
      // non-interactive branch uses — install() already handles a room-less
      // call via routeRoom's fallback to the configured default room.
      if (rooms.length > 0) {
        const peek = install(env, name, source, { dryRun: true }); // side-effect-free room suggestion
        const picked = await pickRooms(rooms, {
          message: `Which room(s) should '${name}' be installed into?`,
          suggested: rooms.some((r) => r.room === peek.room) ? [peek.room] : [],
        });
        if (picked === null) {
          console.log("Cancelled.");
          return;
        }
        if (picked.length === 0) {
          console.error("skill-install: at least one room is required");
          process.exitCode = 1;
          return;
        }
        const [primary, ...extra] = picked as [string, ...string[]];
        const res = install(env, name, source, { room: primary });
        console.log(`✓ Installed ${res.name} → ${res.installedPath}`);
        console.log(`✓ Routed to room: ${res.room}`);
        for (const room of extra) {
          const r = addSkillToAnotherRoom(env, name, room);
          console.log(`✓ Also granted in: ${r.room}${r.roomCreated ? " (room created)" : ""}`);
        }
        return;
      }
    }

    const [primaryRoom, ...extraRooms] = explicitRooms;
    const res = install(env, name, source, {
      ...(primaryRoom ? { room: primaryRoom } : {}),
      dryRun,
    });
    if (res.dryRun) {
      console.log(`Would install: ${res.name}`);
      console.log(`  from: ${res.source}`);
      console.log(`  to:   ${res.installedPath}`);
      console.log(`  room: ${res.room}`);
      for (const room of extraRooms) console.log(`  also: ${room}`);
    } else {
      console.log(`✓ Installed ${res.name} → ${res.installedPath}`);
      console.log(`✓ Routed to room: ${res.room}`);
      for (const room of extraRooms) {
        const r = addSkillToAnotherRoom(env, name, room);
        console.log(`✓ Also granted in: ${r.room}${r.roomCreated ? " (room created)" : ""}`);
      }
    }
  },
});

const skillAssignCmd = defineCommand({
  meta: { name: "skill-assign", description: "Route orphan skills to rooms (report / auto / one room)" },
  args: {
    ...commonArgs,
    auto: { type: "boolean", description: "Auto-assign each orphan to its best room" },
    room: { type: "string", description: "Assign all orphans to this room" },
  },
  run({ args }) {
    const env = envFromArgs(args);
    if (args.auto || args.room) {
      const mode = args.room ? "room" : "auto";
      const { result, env: fresh } = assignOrphansAndReload(env, mode, args.room ? { room: args.room } : {});
      const n = Object.keys(result.assigned).length;
      for (const [skill, room] of Object.entries(result.assigned)) console.log(`  ${skill} → ${room}`);
      generateRoomIndexes(fresh);
      const remaining = getOrphanSkills(fresh).length;
      console.log(`\nAssigned ${n} skill(s). ${remaining} orphan(s) remaining.`);
      return;
    }
    // report (default)
    const res = assignOrphans(env, "report");
    if (res.orphans.length === 0) {
      console.log("✅ All skills are assigned to rooms.");
      return;
    }
    console.log(`⚠️  ${res.orphans.length} unassigned skill(s):\n`);
    for (const o of res.orphans) {
      const sugg = o.scores.slice(0, 3).map((s) => `${s.room}(${s.score})`).join(", ") || "(no clear match)";
      console.log(`  ${o.name}\n    ${o.description.slice(0, 80)}\n    → ${sugg}\n`);
    }
  },
});

const skillRoomAddCmd = defineCommand({
  meta: {
    name: "skill-room-add",
    description: "Grant an already-installed skill access to another room (additive; a room created after the skill exists is fine)",
  },
  args: {
    ...commonArgs,
    skill: { type: "string", description: "Skill name (must already be in the pool)" },
    room: { type: "string", description: "Room(s) to grant, comma-separated for several. Else prompts interactively" },
  },
  async run({ args }) {
    const env = envFromArgs(args);
    const positionals = ((args as Record<string, unknown>)._ as string[] | undefined) ?? [];
    const skill = args.skill ?? positionals[0];
    const rooms = parseRooms(args.room ?? positionals[1]);
    if (!skill) {
      console.error("skill-room-add: a skill name is required");
      process.exitCode = 1;
      return;
    }

    if (rooms.length === 0) {
      if (!canPrompt()) {
        console.error("skill-room-add: --room is required in a non-interactive context");
        process.exitCode = 1;
        return;
      }
      // Fail fast on a mistyped/uninstalled skill BEFORE the interactive
      // prompt — addSkillToAnotherRoom checks this too, but only after the
      // full picker interaction, which is a wasted round-trip for the
      // operator on a simple typo.
      if (!findSkillDir(env, skill)) {
        console.error(`skill-room-add: skill '${skill}' not found in the pool`);
        process.exitCode = 1;
        return;
      }
      const already = roomsForSkill(env, skill);
      const configured = listConfiguredRooms(env);
      // Every configured room already granted ⇒ every picker option would be
      // disabled, but pickRooms' underlying prompt requires a selection —
      // an unwinnable prompt the operator could only escape via Ctrl+C.
      // Short-circuit before it can be shown.
      if (configured.length > 0 && configured.every((r) => already.includes(r.room))) {
        console.log(`'${skill}' is already granted in every configured room (${already.join(", ")}) — nothing to do.`);
        return;
      }
      const picked = await pickRooms(configured, {
        message:
          `Grant '${skill}' access to which additional room(s)?` +
          (already.length ? ` (already in: ${already.join(", ")})` : ""),
        disabledRooms: already,
      });
      if (picked === null) {
        console.log("Cancelled.");
        return;
      }
      if (picked.length === 0) {
        console.error("skill-room-add: at least one room is required");
        process.exitCode = 1;
        return;
      }
      for (const r of picked) {
        const result = addSkillToAnotherRoom(env, skill, r);
        console.log(`✓ Granted '${skill}' in: ${result.room}${result.roomCreated ? " (room created)" : ""}`);
      }
      return;
    }

    for (const r of rooms) {
      const result = addSkillToAnotherRoom(env, skill, r);
      if (!result.changed) {
        console.log(`'${skill}' is already granted in '${r}' — no change.`);
      } else {
        console.log(`✓ Granted '${skill}' in: ${result.room}${result.roomCreated ? " (room created)" : ""}`);
      }
    }
  },
});

const skillUpdateCmd = defineCommand({
  meta: {
    name: "skill-update",
    description: "Overwrite an already-installed skill's pool content in place (room grants untouched)",
  },
  args: {
    ...commonArgs,
    name: { type: "string", description: "Skill name (must already be in the pool)" },
    source: { type: "string", description: "Source directory or SKILL.md file" },
    "dry-run": { type: "boolean", description: "Report the planned overwrite only" },
  },
  run({ args }) {
    const env = envFromArgs(args);
    const positionals = ((args as Record<string, unknown>)._ as string[] | undefined) ?? [];
    const name = args.name ?? positionals[0];
    const source = args.source ?? positionals[1];
    if (!name || !source) {
      console.error("skill-update: a skill name and a source path are both required");
      process.exitCode = 1;
      return;
    }
    let res;
    try {
      res = updateSkill(env, name, source, { dryRun: Boolean(args["dry-run"]) });
    } catch (err) {
      console.error(`skill-update: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    if (res.dryRun) {
      console.log(`Would overwrite: ${res.installedPath}`);
      console.log(`  from: ${res.source}`);
    } else {
      console.log(`✓ Updated ${res.name} ← ${res.source}`);
    }
  },
});

const skillRemoveCmd = defineCommand({
  meta: {
    name: "skill-remove",
    description:
      "Unregister a skill from one room (--room), or fully remove it — unregister everywhere + delete pool files",
  },
  args: {
    ...commonArgs,
    name: { type: "string", description: "Skill name" },
    room: { type: "string", description: "Only unregister from this room; omit for full removal" },
    yes: { type: "boolean", description: "Skip the confirmation prompt (required to proceed non-interactively)" },
  },
  async run({ args }) {
    const env = envFromArgs(args);
    const positionals = ((args as Record<string, unknown>)._ as string[] | undefined) ?? [];
    const name = args.name ?? positionals[0];
    if (!name) {
      console.error("skill-remove: a skill name is required");
      process.exitCode = 1;
      return;
    }
    const room = args.room;
    const isFullRemoval = !room;

    if (!args.yes) {
      const message = isFullRemoval
        ? `Fully remove '${name}' — unregister from every room and delete its pool files?`
        : `Unregister '${name}' from '${room}'? (pool files and other room grants are untouched)`;
      if (!canPrompt()) {
        console.error(`skill-remove: pass --yes to confirm in a non-interactive context (${message})`);
        process.exitCode = 1;
        return;
      }
      if (!(await confirmAction(message))) {
        console.log("Cancelled.");
        return;
      }
    }

    let res;
    try {
      res = removeSkill(env, name, room ? { room } : {});
    } catch (err) {
      console.error(`skill-remove: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    if (res.roomsUnregistered.length === 0 && !res.poolDeleted) {
      console.log(`'${name}' was not registered in '${room}' — no change.`);
      return;
    }
    for (const r of res.roomsUnregistered) console.log(`✓ Unregistered from: ${r}`);
    if (res.poolDeleted) console.log(`✓ Deleted pool files for '${name}'`);
  },
});

// ── Agent integrations (Phase 5) ──────────────────────────────────────────────

const mcpServerCmd = defineCommand({
  meta: { name: "mcp-server", description: "Run the Harbor MCP server over stdio (JSON-RPC; Tier 1 universal)" },
  args: {
    ...commonArgs,
    room: { type: "string", description: "Room (overrides AGENT_ENV_ROOM for this server)" },
    session: { type: "string", description: "Session id (overrides AGENT_ENV_SESSION)" },
  },
  async run({ args }) {
    const env = envFromArgs(args);
    // Lazily import the integration so the CLI's startup path stays light and the
    // `harbor` self-import in the server module is only resolved when serving.
    const { createMcpServer, runStdioServer } = await import("../integrations/mcp-server.ts");
    const procEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(args.room ? { AGENT_ENV_ROOM: args.room } : {}),
      ...(args.session ? { AGENT_ENV_SESSION: args.session } : {}),
    };
    const server = createMcpServer({ env, procEnv });
    await runStdioServer(server);
  },
});

const installCmd = defineCommand({
  meta: {
    name: "install",
    description: "Emit an agent's MCP/integration config (use --write to apply it with a backup)",
  },
  args: {
    ...commonArgs,
    for: { type: "string", description: `Agent: ${AGENT_IDS.join(" | ")}` },
    write: { type: "boolean", description: "Apply the config to the agent's file (backs it up first)" },
    path: { type: "string", description: "Override the target config path" },
    command: { type: "string", description: "Server command (default 'harbor')" },
    "server-name": { type: "string", description: "Entry name (default 'harbor')" },
    room: {
      type: "string",
      description:
        "Default room baked into the emitted config (defaults to the environment's configured default room). " +
        "Used by agents whose config can express a fallback or nothing at all; agents that interpolate live " +
        "still let AGENT_ENV_ROOM from the launching shell win.",
    },
  },
  run({ args }) {
    const agent = args.for as AgentId | undefined;
    if (!agent || !AGENT_IDS.includes(agent)) {
      console.error(`install: --for <agent> is required. Valid agents: ${AGENT_IDS.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const opts = {
      ...(args.command ? { command: args.command } : {}),
      ...(args["server-name"] ? { serverName: args["server-name"] } : {}),
      // Only the "orchestrator" target's format consumes `rooms` (one
      // connection per room); every other agent ignores it. Resolved here,
      // not inside install.ts, so that module stays free of any
      // Environment/config dependency of its own.
      ...(agent === "orchestrator" ? { rooms: Object.keys(envFromArgs(args).config.roomSkills) } : {}),
      // `room` is the room baked into the emitted config. Agents whose config
      // interpolates live (claude-code, gemini) use it only as the `:-default`
      // fallback; ones that cannot substitute at all (goose) use it as the
      // literal value; the rest ignore it. Resolved here, not inside
      // install.ts, so that module stays free of an Environment dependency.
      room: args.room ?? envFromArgs(args).config.skillDefaultRoom,
    };
    if (args.write) {
      const r = applyConfig(agent, { ...opts, ...(args.path ? { path: args.path } : {}) });
      if (r.action === "unchanged") {
        console.log(`install: ${agent} already configured at ${r.path} (no change)`);
      } else {
        console.log(`install: ${r.action} ${r.path}${r.backup ? ` (backup: ${r.backup})` : ""}`);
      }
      return;
    }
    // Default: EMIT to stdout, mutate nothing.
    const s = emitSnippet(agent, opts);
    console.log(s.snippet);
    console.log("");
    for (const line of s.instructions.split("\n")) console.log(`# ${line}`);
    console.log(`#`);
    console.log(`# Nothing was written. Re-run with --write to apply (a backup is made first).`);
  },
});

const secretsCmd = defineCommand({
  meta: {
    name: "secrets",
    description: "Keychain-backed secrets — keep credentials out of agent config files",
  },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Store a secret. The VALUE is read from stdin, never argv." },
      args: { name: { type: "positional", required: true, description: "Secret name" } },
      async run({ args }) {
        // stdin, never argv: a value passed as an argument is visible to `ps`
        // for the lifetime of the call.
        const value = (await Bun.stdin.text()).replace(/\n$/, "");
        if (!value) {
          console.error("secrets set: no value on stdin. Pipe it, e.g.:  printf %s \"$TOKEN\" | harbor secrets set my-key");
          process.exitCode = 1;
          return;
        }
        try {
          await setSecret(args.name, value);
        } catch (err) {
          console.error(`secrets set: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          return;
        }
        console.log(`✓ stored '${args.name}' (${value.length} chars) in the OS keychain`);
      },
    }),
    get: defineCommand({
      meta: { name: "get", description: "Print a secret to stdout (for $(...) capture)" },
      args: { name: { type: "positional", required: true, description: "Secret name" } },
      async run({ args }) {
        const v = await getSecret(args.name);
        if (v == null) {
          console.error(`secrets get: '${args.name}' not found`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(v);
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "Show stored secrets by name + length (never the value)" },
      args: { name: { type: "string", description: "Comma-separated names to check" } },
      async run({ args }) {
        const names = parseCommaList(args.name);
        if (names.length === 0) {
          console.log("usage: harbor secrets list --name a,b,c");
          console.log("(the OS keychain has no portable list-by-service; pass the names to check)");
          return;
        }
        const infos = await describeSecrets(names);
        if (infos.length === 0) {
          console.log("(none of those names are stored)");
          return;
        }
        for (const i of infos) console.log(`  ${i.name.padEnd(28)} ${String(i.length).padStart(5)} chars  ${i.prefix}…`);
      },
    }),
    rm: defineCommand({
      meta: { name: "rm", description: "Remove a secret from the keychain" },
      args: { name: { type: "positional", required: true, description: "Secret name" } },
      async run({ args }) {
        console.log((await removeSecret(args.name)) ? `✓ removed '${args.name}'` : `'${args.name}' was not stored`);
      },
    }),
    export: defineCommand({
      meta: { name: "export", description: "Emit shell export lines that resolve from the keychain at run time" },
      args: { name: { type: "string", description: "Comma-separated secret names" } },
      async run({ args }) {
        const names = parseCommaList(args.name);
        if (names.length === 0) {
          console.error("secrets export: --name a,b,c is required");
          process.exitCode = 1;
          return;
        }
        for (const line of await exportLines(names)) console.log(line);
      },
    }),
    doctor: defineCommand({
      meta: {
        name: "doctor",
        description: "Scan every supported agent's config for credentials sitting in plaintext",
      },
      args: { home: { type: "string", description: "Home dir to resolve agent config paths under" } },
      run({ args }) {
        const home = args.home ?? defaultHome();
        const findings = scanConfigs(agentConfigPaths(home));
        if (findings.length === 0) {
          console.log("✅ No plaintext credentials found in any supported agent's config.");
          return;
        }
        console.log(`⚠️  ${findings.length} plaintext credential(s) found:\n`);
        for (const f of findings) {
          const tag = f.expired ? " [EXPIRED — delete it, do not migrate]" : "";
          console.log(`  ${f.file}`);
          console.log(`    ${f.location}  (${f.kind}, ${f.length} chars, ${f.prefix}…)${tag}`);
        }
        console.log(`\nMove each into the keychain, then reference it from the config:`);
        console.log(`  printf %s "$VALUE" | harbor secrets set <name>`);
        console.log(`  harbor secrets export --name <name>   # add to your shell profile`);
        console.log(`\nNote: clients differ on substitution syntax — see 'harbor install --for <agent>'.`);
        process.exitCode = 1;
      },
    }),
  },
});

const buzzPackCmd = defineCommand({
  meta: {
    name: "buzz-pack",
    description: "Emit a Buzz Persona Pack from Harbor rooms (one room -> one persona)",
  },
  args: {
    ...commonArgs,
    out: { type: "string", description: "Output directory for the pack" },
    room: { type: "string", description: "Emit a single room (default: every configured room)" },
    id: { type: "string", description: "Pack id (default 'com.harbor.rooms')" },
    name: { type: "string", description: "Pack display name (default 'Harbor Rooms')" },
    version: { type: "string", description: "Pack version (default '0.1.0')" },
    "dry-run": { type: "boolean", description: "Show what would be emitted, write nothing" },
    "private-term": {
      type: "string",
      description: "Comma-separated terms to warn about in descriptions before publishing",
    },
  },
  run({ args }) {
    const env = envFromArgs(args);
    let plan;
    try {
      plan = planPack(env, {
        ...(args.room ? { room: args.room } : {}),
        ...(args.id ? { packId: args.id } : {}),
        ...(args.name ? { packName: args.name } : {}),
        ...(args.version ? { version: args.version } : {}),
      });
    } catch (err) {
      console.error(`buzz-pack: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    console.log(`${plan.personas.length} persona(s) from Harbor rooms:`);
    for (const p of plan.personas) {
      console.log(`  ${p.name.padEnd(22)} ${String(p.skills.length).padStart(3)} skill(s)  ${p.mcp_servers.length} mcp`);
    }
    console.log(`  ${plan.skillsToCopy.length} unique skill(s) to copy`);

    // Buzz drops a command-less MCP server SILENTLY; say so here instead.
    for (const d of plan.droppedServers) {
      console.log(`  ⚠️  ${d.room}: dropped MCP server '${d.server}' — ${d.reason}`);
    }
    for (const m of plan.missingSkills) {
      console.log(`  ⚠️  ${m.room}: skill '${m.skill}' is not in the pool — omitted`);
    }

    // A pack embeds room descriptions and full skill CONTENT. Warn BEFORE it
    // is written, because publishing one is equivalent to publishing the
    // skills themselves.
    const terms = parseCommaList(args["private-term"]);
    const hits = findSensitive(plan, terms);
    if (hits.length > 0) {
      console.log("");
      console.log("⚠️  Private terms appear in:");
      for (const h of hits) console.log(`     ${h}`);
    }

    if (!args.out || args["dry-run"]) {
      console.log("");
      console.log(args.out ? "Dry run — nothing written." : "No --out given — nothing written.");
      return;
    }

    const res = writePack(env, plan, args.out);
    console.log("");
    console.log(`✓ Wrote pack to ${res.outDir}`);
    console.log(`  ${res.personaFiles.length} persona file(s), ${res.skillsCopied} skill(s) copied`);
    console.log("");
    console.log("Validate it with Buzz before use:  buzz pack validate " + res.outDir);
    console.log("A pack contains your skill CONTENT — review before publishing it anywhere.");
  },
});

const channelToolsCmd = defineCommand({
  meta: {
    name: "channel-tools",
    description: "Show the skills + MCP servers a Buzz channel exposes (reads ~/.buzz/channel-tools.toml)",
  },
  args: {
    ...commonArgs,
    channel: { type: "positional", required: false, description: "Channel name or UUID (omit for a directory of all mapped channels)" },
    policy: { type: "string", description: "Path to channel-tools.toml (default ~/.buzz/channel-tools.toml)" },
    map: { type: "boolean", description: "Scope this channel on the fly: create its room + record the mapping" },
    room: { type: "string", description: "Room to map to (with --map; default: derived from the channel name)" },
    json: { type: "boolean", description: "Emit JSON (the shape the Buzz GUI panel reads)" },
  },
  run({ args }) {
    const env = envFromArgs(args);
    const policyPath = args.policy ?? defaultPolicyPath();
    const channel = args.channel as string | undefined;

    // --map: ensure the channel is scoped (create room + mapping), then report.
    if (args.map) {
      if (!channel) {
        console.error("channel-tools --map: a channel is required");
        process.exitCode = 1;
        return;
      }
      let result;
      try {
        result = mapChannel(env, policyPath, channel, args.room);
      } catch (err) {
        if (err instanceof ChannelToolsError) {
          console.error(`channel-tools: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      if (args.json) {
        printJson(result);
        return;
      }
      console.log(
        result.mappingCreated
          ? `✓ Scoped '${result.channel}' → room '${result.room}'`
          : `'${result.channel}' is already scoped → room '${result.room}'`,
      );
      return;
    }

    // No channel argument → directory view of every mapped channel.
    if (!channel) {
      let channels;
      try {
        channels = listChannels(policyPath);
      } catch (err) {
        if (err instanceof ChannelToolsError) {
          console.error(`channel-tools: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      if (args.json) {
        printJson(channels);
        return;
      }
      if (channels.length === 0) {
        console.log(`(no channels mapped in ${policyPath})`);
        return;
      }
      console.log(`Channels mapped in ${policyPath}:`);
      for (const c of channels) console.log(`  ${c.channel.padEnd(28)} → ${c.room ?? "(no room)"}`);
      console.log("");
      console.log("Show one:  harbor channel-tools <channel>");
      return;
    }

    let tools;
    try {
      tools = resolveChannelTools(env, policyPath, channel);
    } catch (err) {
      if (err instanceof ChannelToolsError) {
        console.error(`channel-tools: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    if (args.json) {
      printJson(tools);
      return;
    }

    if (!tools.scoped) {
      console.log(`Channel '${channel}' has no entry in ${policyPath}.`);
      console.log("It is NOT Harbor-scoped — the agent keeps its harness's own configured extensions.");
      return;
    }
    if (!tools.room) {
      console.log(`Channel '${channel}' is mapped but has no room.`);
      if (tools.mcpServers.length > 0) {
        console.log("Explicit MCP servers:");
        for (const m of tools.mcpServers) console.log(`  ${m.name}  (${m.source})`);
      }
      return;
    }

    console.log(`Channel '${channel}' → room '${tools.room}'`);
    console.log("");
    console.log(`Skills (${tools.skills.length}):`);
    if (tools.skills.length === 0) console.log("  (none)");
    for (const s of tools.skills) {
      const flag = s.present ? " " : "!";
      const desc = s.description ? `  — ${s.description}` : "";
      console.log(` ${flag} ${s.name}${desc}`);
    }
    console.log("");
    console.log(`MCP servers (${tools.mcpServers.length}):`);
    if (tools.mcpServers.length === 0) console.log("  (none)");
    for (const m of tools.mcpServers) console.log(`  ${m.name}  (${m.source})`);
    console.log("");
    console.log("Add a NEW skill to this channel:      harbor skill-install <src> --room " + tools.room);
    console.log("Add an EXISTING skill to this channel: harbor skill-room-add <skill> --room " + tools.room);
    console.log("Add an MCP server to this channel:     harbor mcp-add --room " + tools.room + " --name <n> --command <cmd>");
  },
});

const approvalCmd = defineCommand({
  meta: {
    name: "approval",
    description: "Human-in-the-loop grants for a cross-room skill load (docs/SPEC_hardening.md step 2)",
  },
  subCommands: {
    grant: defineCommand({
      meta: {
        name: "grant",
        description: "Pre-approve a specific (session, room, resource) cross-room request",
      },
      args: {
        ...commonArgs,
        session: { type: "positional", required: true, description: "Session id making the request" },
        room: { type: "positional", required: true, description: "The room the session is scoped to" },
        resource: { type: "positional", required: true, description: "The skill/resource being requested" },
        minutes: { type: "string", description: `Grant lifetime in minutes (default 15, max ${MAX_GRANT_SECONDS / 60})` },
        approver: { type: "string", description: "Your name/identifier, recorded in the audit trail" },
      },
      run({ args }) {
        const env = envFromArgs(args);
        const minutes = args.minutes ? Number.parseInt(args.minutes, 10) : 15;
        if (!Number.isFinite(minutes) || minutes <= 0) {
          console.error("approval grant: --minutes must be a positive number");
          process.exitCode = 1;
          return;
        }
        const now = Date.now() / 1000;
        const grant = saveGrant(
          env,
          {
            sessionId: args.session,
            room: args.room,
            tool: "read_skill",
            resource: args.resource,
            targetRoom: "",
            reason: "manually approved via `harbor approval grant`",
          },
          { granted: true, expiresAt: now + minutes * 60, approver: args.approver ?? "" },
          now,
        );
        const actualMinutes = Math.round((grant.expiresAt - now) / 60);
        console.log(
          `✓ Granted '${grant.resource}' to session '${grant.sessionId}' in room '${grant.room}' ` +
            `for ${actualMinutes} minute(s)${grant.approver ? ` (approver: ${grant.approver})` : ""}.`,
        );
        if (actualMinutes < minutes) {
          console.log(`  (clamped from ${minutes}m — grants cannot exceed ${MAX_GRANT_SECONDS / 60}m)`);
        }
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "Show every live (unexpired) grant" },
      args: { ...commonArgs },
      run({ args }) {
        const env = envFromArgs(args);
        const grants = listGrants(env);
        if (grants.length === 0) {
          console.log("(no live grants)");
          return;
        }
        const now = Date.now() / 1000;
        for (const g of grants) {
          const remaining = Math.round((g.expiresAt - now) / 60);
          console.log(
            `  ${g.sessionId.padEnd(16)} ${g.room.padEnd(16)} ${g.resource.padEnd(24)} ` +
              `${remaining}m left${g.approver ? `  (${g.approver})` : ""}`,
          );
        }
      },
    }),
    purge: defineCommand({
      meta: { name: "purge", description: "Delete every expired grant row" },
      args: { ...commonArgs },
      run({ args }) {
        const n = purgeExpiredGrants(envFromArgs(args));
        console.log(`purged ${n} expired grant(s)`);
      },
    }),
  },
});

// ── Root command ──────────────────────────────────────────────────────────────

export const main: CommandDef = defineCommand({
  meta: {
    name: "harbor",
    version: pkg.version,
    description: "Agent control plane — scheduler, compaction, isolation, sessions.",
  },
  subCommands: {
    sync: syncCmd,
    watch: watchCmd,
    start: startCmd,
    stop: stopCmd,
    dashboard: dashboardCmd,
    bench: benchCmd,
    scheduler: schedulerCmd,
    compaction: compactionCmd,
    isolation: isolationCmd,
    session: sessionCmd,
    spawn: spawnCmd,
    budget: budgetCmd,
    gate: gateCmd,
    audit: auditCmd,
    check: checkCmd,
    init: initCmd,
    setup: setupCmd,
    "skills-list": skillsListCmd,
    "mcp-check": mcpCheckCmd,
    "mcp-add": mcpAddCmd,
    "mcp-remove": mcpRemoveCmd,
    "mcp-gen": mcpGenCmd,
    "mcp-merge": mcpMergeCmd,
    "skill-create": skillCreateCmd,
    "skill-install": skillInstallCmd,
    "skill-assign": skillAssignCmd,
    "skill-room-add": skillRoomAddCmd,
    "skill-update": skillUpdateCmd,
    "skill-remove": skillRemoveCmd,
    "mcp-server": mcpServerCmd,
    install: installCmd,
    secrets: secretsCmd,
    "buzz-pack": buzzPackCmd,
    "channel-tools": channelToolsCmd,
    approval: approvalCmd,
  },
});

if (import.meta.main) {
  void runMain(main);
}
