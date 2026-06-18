/**
 * watch.ts — File-watcher daemon that regenerates beacons on change.
 *
 * Wraps `chokidar` (native FSEvents on macOS) to watch the config-declared
 * paths and, on change, regenerate the home beacons in-process — no subprocess.
 * Port of the Python prototype's `beacon_watcher.py`.
 *
 * Behavioral-fidelity notes (from `beacon_watcher.py`, where SPEC_TS is silent):
 *   - Cooldown coalescing (the prototype's CooldownGate, "Decision #11"): the
 *     first event (or one past the cooldown window) fires a sync *immediately*;
 *     events inside the window are coalesced into a single *deferred* sync that
 *     fires once the window elapses — coalesced, never dropped. {@link CooldownGate}
 *     captures this exactly with an injectable clock.
 *   - On a fired event the watcher regenerates beacons via `sync.runGenerate`
 *     (NOT `fullSync`): it never re-scaffolds project stubs into watched dirs.
 *     This is deliberate — re-scaffolding into a watched root is exactly the
 *     contamination this build is avoiding (BUILD_BRIEF watch.ts caution).
 *   - PID file at `env.watcherPidfile`: a running daemon is detected via the
 *     pidfile + a liveness probe; a stale pidfile (dead pid) is recovered.
 *
 * Tests must only ever watch throwaway temp directories — never a real home or
 * workspace. The integration test here does exactly that.
 */
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Environment } from "./env.ts";
import { runGenerate } from "./sync.ts";

// ── Cooldown gate ─────────────────────────────────────────────────────────────

/**
 * Debounce gate that coalesces rapid file events into bounded syncs. Clock
 * returns epoch *seconds* (injectable for deterministic tests).
 */
export class CooldownGate {
  private lastSync: number | null = null;
  private pending = false;

  constructor(
    readonly cooldownSeconds: number,
    private readonly clock: () => number = () => Date.now() / 1000,
  ) {}

  /** Record an event. Returns true if a sync should fire *now*. */
  onEvent(): boolean {
    const now = this.clock();
    if (this.lastSync === null || now - this.lastSync >= this.cooldownSeconds) {
      this.lastSync = now;
      this.pending = false;
      return true;
    }
    // Within the cooldown window — coalesce into a single deferred sync.
    this.pending = true;
    return false;
  }

  /** Returns true (once) when a coalesced event's cooldown has elapsed. */
  due(): boolean {
    if (!this.pending) return false;
    const now = this.clock();
    if (this.lastSync !== null && now - this.lastSync >= this.cooldownSeconds) {
      this.lastSync = now;
      this.pending = false;
      return true;
    }
    return false;
  }

  get isPending(): boolean {
    return this.pending;
  }
}

// ── PID file ──────────────────────────────────────────────────────────────────

/** A daemon pidfile with liveness checks. */
export class PidFile {
  constructor(readonly path: string) {}

  write(pid: number): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${pid}\n`);
  }

  read(): number | null {
    if (!existsSync(this.path)) return null;
    const first = readFileSync(this.path, "utf8").split("\n")[0]?.trim();
    if (!first) return null;
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) ? pid : null;
  }

  /** True when the pidfile names a live process. */
  isRunning(): boolean {
    const pid = this.read();
    if (pid === null) return false;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
      return true;
    } catch (err) {
      // EPERM means the process exists but is owned by another user → running.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}

// ── Watcher ───────────────────────────────────────────────────────────────────

export type SyncFn = (reason: string) => void;

export interface WatcherOptions {
  /** Paths to watch; defaults to `env.watchPaths()`. */
  paths?: string[];
  /** Cooldown seconds; defaults to `config.watchCooldown`. */
  cooldownSeconds?: number;
  /** Injectable clock (epoch seconds). */
  clock?: () => number;
  /** Sync action; defaults to regenerating home beacons via `runGenerate`. */
  syncFn?: SyncFn;
  /** How often (ms) to check the cooldown gate for a due deferred sync. */
  pollIntervalMs?: number;
  /** Extra chokidar options (tests use `{ usePolling: true }` for determinism). */
  chokidarOptions?: Record<string, unknown>;
}

/** A live file watcher that regenerates beacons on change, with cooldown coalescing. */
export class Watcher {
  readonly gate: CooldownGate;
  private readonly paths: string[];
  private readonly syncFn: SyncFn;
  private readonly pollIntervalMs: number;
  private readonly chokidarOptions: Record<string, unknown>;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Number of syncs fired this lifetime (observability + tests). */
  syncCount = 0;

  constructor(
    private readonly env: Environment,
    options: WatcherOptions = {},
  ) {
    this.paths = options.paths ?? env.watchPaths();
    this.gate = new CooldownGate(
      options.cooldownSeconds ?? env.config.watchCooldown,
      options.clock,
    );
    this.syncFn = options.syncFn ?? ((reason) => void this.defaultSync(reason));
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.chokidarOptions = options.chokidarOptions ?? {};
  }

  private defaultSync(_reason: string): void {
    runGenerate(this.env);
  }

  private fire(reason: string): void {
    this.syncCount += 1;
    this.syncFn(reason);
  }

  /** Begin watching. Existing files don't trigger an initial sync (ignoreInitial). */
  start(): void {
    this.watcher = chokidarWatch(this.paths, {
      ignoreInitial: true,
      ...this.chokidarOptions,
    });
    this.watcher.on("all", () => {
      if (this.gate.onEvent()) this.fire("change detected");
    });
    // Periodically flush a coalesced (deferred) sync once its cooldown elapses.
    this.timer = setInterval(() => {
      if (this.gate.due()) this.fire("deferred sync");
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

// ── Daemon lifecycle ──────────────────────────────────────────────────────────

export interface WatcherStatus {
  running: boolean;
  pid: number | null;
}

/** Report whether the watcher daemon is running, per its pidfile. */
export function watcherStatus(env: Environment): WatcherStatus {
  const pidfile = new PidFile(env.watcherPidfile);
  return { running: pidfile.isRunning(), pid: pidfile.read() };
}

/**
 * Start the watcher as a detached background process (`harbor watch` re-invoked
 * via Bun.spawn). Returns the child pid, or the existing pid if already running.
 */
export function startDaemon(env: Environment, cliEntry: string): number {
  const pidfile = new PidFile(env.watcherPidfile);
  if (pidfile.isRunning()) return pidfile.read() as number;
  // Recover a stale pidfile from a dead previous run.
  if (existsSync(env.watcherPidfile)) pidfile.remove();

  mkdirSync(env.logsDir, { recursive: true });
  const args = ["run", cliEntry, "watch"];
  if (env.configPath) args.push("--config", env.configPath);
  else args.push("--root", env.root);
  const child = Bun.spawn(["bun", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  pidfile.write(child.pid);
  return child.pid;
}

/** Stop the running watcher daemon. Returns true if a process was signalled. */
export function stopDaemon(env: Environment): boolean {
  const pidfile = new PidFile(env.watcherPidfile);
  const pid = pidfile.read();
  if (pid === null || !pidfile.isRunning()) {
    pidfile.remove();
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  pidfile.remove();
  return true;
}

/**
 * Run the watcher in the foreground until the returned stop handle is called.
 * Writes the pidfile so `status`/`stop` can find this process.
 */
export function runForeground(env: Environment, options: WatcherOptions = {}): {
  watcher: Watcher;
  stop: () => Promise<void>;
} {
  const pidfile = new PidFile(env.watcherPidfile);
  pidfile.write(process.pid);
  const watcher = new Watcher(env, options);
  watcher.start();
  return {
    watcher,
    stop: async () => {
      await watcher.stop();
      pidfile.remove();
    },
  };
}
