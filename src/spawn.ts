/**
 * spawn.ts — HYPERVISOR: process ownership.
 *
 * `spawn(command, args, opts)` wraps `Bun.spawn()` so Harbor OWNS the child: it
 * tracks the PID, attaches a session (token budget), enforces a wall-clock
 * timeout, records the room/session via env vars, and carries an allowed-paths
 * sandbox descriptor. The returned {@link HarborChildProcess} exposes the raw
 * subprocess surface (`pid`, `exited`, `exitCode`, `kill`, `stdout`/`stderr`)
 * plus Harbor metadata (`room`, `sessionId`, `budget`, `tokensUsed`,
 * `budgetRemaining`).
 *
 * SPEC_TS §3.1 defines this primitive — there is NO Python equivalent. The
 * prototype's `scheduler.py` shells out per task with `subprocess.run` (one-shot,
 * fire-and-forget); it never owns a long-lived agent process with a budget and a
 * session. So the spec is the reference here, and the tests assert the behavior
 * it describes (PID tracked, env injected, timeout → exitCode -1, session
 * created with the process).
 *
 * Honest enforcement note (BUILD_BRIEF §6): `allowedPaths` is a logical sandbox
 * descriptor recorded as metadata and injected for the child's own tool layer to
 * honor. It is NOT OS-level confinement in v1 (no bwrap/seccomp). Do not
 * over-claim: a child with raw filesystem access is not physically confined.
 *
 * Uses `Bun.spawn` (async, owned) — never `Bun.spawnSync`. Timeout is enforced
 * in-process with `setTimeout` + `proc.kill()` rather than spawnSync's blocking
 * `timeout`, because Harbor must retain control of the live PID.
 */
import { Environment } from "./env.ts";
import { CompactionEngine } from "./compaction.ts";
import { SessionTracker } from "./session.ts";
import { emitHypervisorEvent } from "./audit.ts";

const nowSec = (): number => Date.now() / 1000;

/** Options for {@link spawn}. */
export interface HarborSpawnOptions {
  /** Room the child runs in. Defaults to the config's default room. */
  room?: string;
  /** Explicit session id; otherwise a fresh session is created. */
  sessionId?: string;
  /** Token budget for the child's session. Defaults to `config.roomBudget(room)`. */
  budget?: number;
  /** Wall-clock timeout in milliseconds. After it elapses the child is killed. */
  timeout?: number;
  /** Logical filesystem sandbox (metadata + `AGENT_ENV_ALLOWED_PATHS`; see header). */
  allowedPaths?: string[];
  /** Extra environment variables for the child. */
  env?: Record<string, string>;
  /** Working directory for the child. */
  cwd?: string;
  /** Harbor environment (state/session dirs). Defaults to {@link Environment.default}. */
  harborEnv?: Environment;
  /** Create + roll up a tracked session for the child. Default true. */
  track?: boolean;
}

/** A Harbor-owned child process: the Bun subprocess surface + Harbor metadata. */
export interface HarborChildProcess {
  readonly pid: number;
  readonly room: string;
  readonly sessionId: string;
  readonly budget: number;
  readonly allowedPaths: readonly string[];
  /** True once the wall-clock timeout fired and the child was killed. */
  readonly timedOut: boolean;
  /** Native exit code, or `-1` if the child was killed by the Harbor timeout. */
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  /** Resolves to the (normalized) exit code: `-1` on timeout. */
  readonly exited: Promise<number>;
  /** Tokens used by the child's session (live, from session state). */
  readonly tokensUsed: number;
  /** `budget - tokensUsed`, clamped at 0. */
  readonly budgetRemaining: number;
  readonly stdout: ReadableStream<Uint8Array> | number | undefined;
  readonly stderr: ReadableStream<Uint8Array> | number | undefined;
  /** The raw Bun subprocess (escape hatch for advanced use). */
  readonly subprocess: Bun.Subprocess;
  kill(signal?: number | NodeJS.Signals): void;
}

/** Thrown when a caller awaits a timed-out spawn via {@link awaitExit}. */
export class SpawnTimeoutError extends Error {
  readonly sessionId: string;
  readonly command: string;
  readonly timeoutMs: number;
  constructor(init: { sessionId: string; command: string; timeoutMs: number }) {
    super(`Spawn '${init.command}' (session ${init.sessionId}) exceeded ${init.timeoutMs}ms timeout`);
    this.name = "SpawnTimeoutError";
    this.sessionId = init.sessionId;
    this.command = init.command;
    this.timeoutMs = init.timeoutMs;
  }
}

/** A snapshot of a live spawn (for the dashboard hypervisor panel). */
export interface SpawnInfo {
  pid: number;
  room: string;
  sessionId: string;
  command: string;
  budget: number;
  tokensUsed: number;
  budgetRemaining: number;
}

const activeChildren = new Set<HarborChild>();

/** Snapshots of the spawns this process currently owns (in-process only). */
export function listActiveSpawns(): SpawnInfo[] {
  return [...activeChildren].map((c) => c.info());
}

/**
 * Tokens used by the child, read from the authoritative in-process budget store
 * (`compaction.db`) — the SAME store `budget.spendBudget` debits. So as the child
 * spends via the hypervisor budget calls, `budgetRemaining` auto-updates (spec
 * §3.1). The SessionTracker rollup (sessions.db) is the dashboard's history view;
 * the compaction store is the live budget.
 */
function readTokensUsed(env: Environment, sessionId: string): number {
  if (!sessionId) return 0;
  const engine = new CompactionEngine({ env, sessionId });
  try {
    return engine.tokensUsed;
  } finally {
    engine.close();
  }
}

class HarborChild implements HarborChildProcess {
  readonly room: string;
  readonly sessionId: string;
  readonly budget: number;
  readonly allowedPaths: readonly string[];
  readonly exited: Promise<number>;
  private readonly proc: Bun.Subprocess;
  private readonly env: Environment;
  private readonly tracker: SessionTracker | null;
  private readonly command: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _timedOut = false;

  constructor(init: {
    proc: Bun.Subprocess;
    env: Environment;
    room: string;
    sessionId: string;
    budget: number;
    allowedPaths: string[];
    tracker: SessionTracker | null;
    command: string;
    timeout?: number;
  }) {
    this.proc = init.proc;
    this.env = init.env;
    this.room = init.room;
    this.sessionId = init.sessionId;
    this.budget = init.budget;
    this.allowedPaths = init.allowedPaths;
    this.tracker = init.tracker;
    this.command = init.command;

    if (init.timeout && init.timeout > 0) {
      this.timer = setTimeout(() => {
        this._timedOut = true;
        try {
          this.proc.kill();
        } catch {
          // already gone
        }
      }, init.timeout);
    }

    this.exited = this.proc.exited.then((code) => {
      if (this.timer) clearTimeout(this.timer);
      const finalCode = this._timedOut ? -1 : code;
      if (this.tracker) {
        const status = this._timedOut ? "timeout" : finalCode === 0 ? "completed" : "failed";
        try {
          this.tracker.end(status, `exit=${finalCode}`);
        } catch {
          // best-effort rollup
        }
      }
      activeChildren.delete(this);
      emitHypervisorEvent({
        kind: "spawn",
        event: "completed",
        sessionId: this.sessionId,
        room: this.room,
        pid: this.proc.pid,
        command: this.command,
        tokens: this.tokensUsed,
        timestamp: nowSec(),
      });
      return finalCode;
    });
  }

  get pid(): number {
    return this.proc.pid;
  }
  get timedOut(): boolean {
    return this._timedOut;
  }
  get exitCode(): number | null {
    return this._timedOut ? -1 : this.proc.exitCode;
  }
  get signalCode(): string | null {
    return (this.proc.signalCode as string | null) ?? null;
  }
  get stdout(): ReadableStream<Uint8Array> | number | undefined {
    return this.proc.stdout as ReadableStream<Uint8Array> | number | undefined;
  }
  get stderr(): ReadableStream<Uint8Array> | number | undefined {
    return this.proc.stderr as ReadableStream<Uint8Array> | number | undefined;
  }
  get subprocess(): Bun.Subprocess {
    return this.proc;
  }
  get tokensUsed(): number {
    return readTokensUsed(this.env, this.sessionId);
  }
  get budgetRemaining(): number {
    return Math.max(0, this.budget - this.tokensUsed);
  }
  kill(signal?: number | NodeJS.Signals): void {
    this.proc.kill(signal);
  }
  info(): SpawnInfo {
    return {
      pid: this.pid,
      room: this.room,
      sessionId: this.sessionId,
      command: this.command,
      budget: this.budget,
      tokensUsed: this.tokensUsed,
      budgetRemaining: this.budgetRemaining,
    };
  }
}

/**
 * Spawn a Harbor-owned child process. Creates a tracked session (unless
 * `track: false`), injects `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION`, and enforces
 * an optional wall-clock timeout. Returns a {@link HarborChildProcess}.
 */
export function spawn(
  command: string,
  args: string[] = [],
  options: HarborSpawnOptions = {},
): HarborChildProcess {
  const env = options.harborEnv ?? Environment.default();
  const room = options.room ?? env.config.skillDefaultRoom;
  const budget = options.budget ?? env.config.roomBudget(room);
  const track = options.track ?? true;

  let sessionId = options.sessionId ?? "";
  let tracker: SessionTracker | null = null;
  if (track) {
    tracker = new SessionTracker({ env, ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
    const state = tracker.start(room, { budget });
    sessionId = state.sessionId;
  }
  // Seed the in-process budget store (compaction.db) with this session's limit so
  // the hypervisor budget calls (checkBudget/spendBudget) enforce `budget`, and
  // child.tokensUsed/budgetRemaining track the same store. No-op if no session.
  if (sessionId) {
    new CompactionEngine({ env, sessionId, room, tokenLimit: budget }).close();
  }

  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(options.env ?? {}),
    AGENT_ENV_ROOM: room,
    AGENT_ENV_SESSION: sessionId,
  };
  if (options.allowedPaths && options.allowedPaths.length > 0) {
    childEnv.AGENT_ENV_ALLOWED_PATHS = options.allowedPaths.join(":");
  }

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([command, ...args], {
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } catch (err) {
    // Don't leak a started session if the binary can't be launched.
    if (tracker) {
      try {
        tracker.end("failed", `spawn error: ${(err as Error).message ?? err}`);
      } catch {
        // best-effort
      }
    }
    throw err;
  }

  const child = new HarborChild({
    proc,
    env,
    room,
    sessionId,
    budget,
    allowedPaths: options.allowedPaths ?? [],
    tracker,
    command,
    ...(options.timeout != null ? { timeout: options.timeout } : {}),
  });
  activeChildren.add(child);

  emitHypervisorEvent({
    kind: "spawn",
    event: "started",
    sessionId,
    room,
    pid: proc.pid,
    command,
    timestamp: nowSec(),
  });
  return child;
}

/**
 * Await a child's exit, rejecting with {@link SpawnTimeoutError} if it was killed
 * by its timeout. (`child.exited` itself always resolves — to `-1` on timeout —
 * for callers that prefer to branch on the code.)
 */
export async function awaitExit(child: HarborChildProcess): Promise<number> {
  const code = await child.exited;
  if (child.timedOut) {
    throw new SpawnTimeoutError({ sessionId: child.sessionId, command: "", timeoutMs: 0 });
  }
  return code;
}
