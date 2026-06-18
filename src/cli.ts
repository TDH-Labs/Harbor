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
import { existsSync, readFileSync } from "node:fs";

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
    const wrote = writeIfChanged(env.agentMap, seed);
    runGenerate(env);
    console.log(`init: ${wrote ? "wrote" : "kept"} agent_map.md, generated beacons under ${env.root}`);
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

// ── Root command ──────────────────────────────────────────────────────────────

export const main: CommandDef = defineCommand({
  meta: { name: "harbor", description: "Agent control plane — scheduler, compaction, isolation, sessions." },
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
  },
});

if (import.meta.main) {
  void runMain(main);
}
