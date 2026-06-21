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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

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
import { listSkills, generateRoomIndexes } from "./skills.ts";
import {
  generateRoomConfig,
  generateRoomConfigs,
  mergeConfigs,
  roomsWithMcp,
  validateAllRooms,
  validateRoom,
} from "./mcp.ts";
import { scaffold } from "./skill-create.ts";
import { install } from "./skill-install.ts";
import { assignOrphans, assignOrphansAndReload, getOrphanSkills } from "./skill-assign.ts";
import { AGENT_IDS, applyConfig, emitSnippet, type AgentId } from "./install.ts";

// ── Environment resolution ────────────────────────────────────────────────────

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
        console.log(args.json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
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
        `${wroteMap ? ", seeded agent_map.md" : ""}, generated beacons`,
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
  args: { ...commonArgs, room: { type: "string", description: "Filter to one room" } },
  run({ args }) {
    const env = envFromArgs(args);
    const skills = listSkills(env, args.room);
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
      console.log(JSON.stringify(merged, null, 2));
    }
  },
});

const skillCreateCmd = defineCommand({
  meta: { name: "skill-create", description: "Scaffold a new skill with a TDD harness" },
  args: {
    ...commonArgs,
    name: { type: "positional", required: true, description: "Skill slug" },
    room: { type: "string", description: "Target room (required to register)" },
    description: { type: "string", description: "One-line description" },
    "no-register": { type: "boolean", description: "Scaffold only; do not register" },
    dir: { type: "string", description: "Working directory (default ./skills-in-progress)" },
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

const skillInstallCmd = defineCommand({
  meta: { name: "skill-install", description: "Install a skill into the pool and route it to a room" },
  args: {
    ...commonArgs,
    // Positionals are read from args._ (citty mis-parses multiple declared
    // positionals). Forms: `<source>` (name = basename) or `<name> <source>`.
    name: { type: "string", description: "Skill slug (else derived from the source path)" },
    source: { type: "string", description: "Source directory or SKILL.md file" },
    room: { type: "string", description: "Target room (else auto-routed by score)" },
    "dry-run": { type: "boolean", description: "Report source/destination/room only" },
  },
  run({ args }) {
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
    const res = install(env, name, source, {
      ...(args.room ? { room: args.room } : {}),
      dryRun: Boolean(args["dry-run"]),
    });
    if (res.dryRun) {
      console.log(`Would install: ${res.name}`);
      console.log(`  from: ${res.source}`);
      console.log(`  to:   ${res.installedPath}`);
      console.log(`  room: ${res.room}`);
    } else {
      console.log(`✓ Installed ${res.name} → ${res.installedPath}`);
      console.log(`✓ Routed to room: ${res.room}`);
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
    "mcp-gen": mcpGenCmd,
    "mcp-merge": mcpMergeCmd,
    "skill-create": skillCreateCmd,
    "skill-install": skillInstallCmd,
    "skill-assign": skillAssignCmd,
    "mcp-server": mcpServerCmd,
    install: installCmd,
  },
});

if (import.meta.main) {
  void runMain(main);
}
