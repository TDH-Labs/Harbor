/**
 * scheduler.ts — Deterministic priority-queue task dispatcher.
 *
 * A priority queue with deadline awareness, per-room daily token-budget
 * enforcement, exponential-backoff retry, recurring tasks, and crash recovery.
 * Persisted to SQLite (`scheduler.db`).
 *
 * Design principles (from the Python prototype, ARCHITECTURE.md):
 *   - Deterministic: no LLM in the scheduling path — pure priority + deadline.
 *   - Budget-aware: refuses dispatch when a task's budget would exhaust the room.
 *   - Crash-safe: task state is committed to SQLite; the queue rebuilds from it.
 *   - Loop-safe: recurring tasks re-enqueue a fresh copy on completion.
 *
 * Behavioral fidelity notes (BUILD_BRIEF §4 — undocumented behavior consulted
 * against the prototype and pinned by tests):
 *   - Budget-exceeded is *head-of-line blocking*: the highest-priority task that
 *     would exceed its room's daily budget stalls the queue (returns nothing)
 *     rather than letting lower tasks jump it. Matches `scheduler.py::_pop_next`.
 *   - Retry backoff is `min(2^retryCount, 60)` seconds. The prototype blocked
 *     the whole scheduler with `time.sleep`; v1 instead stamps an `available_at`
 *     and the task simply isn't eligible until then — non-blocking, so unrelated
 *     ready tasks still run. (Documented deviation.)
 *   - Retry lowers a task's priority. The prototype intended this ("lower
 *     priority on retry") but decremented a *negated* heap key, which actually
 *     *raised* effective priority — a bug. v1 stores priority un-negated, so the
 *     decrement lowers it as intended.
 *   - Scheduling policies (FIFO / DEADLINE) are fully wired here; the prototype
 *     declared them but `_pop_next` ignored the policy and always ran priority
 *     order.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Environment } from "./env.ts";

// ── Types ──────────────────────────────────────────────────────────────────--

export enum TaskState {
  QUEUED = "queued",
  DISPATCHED = "dispatched",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum SchedulingPolicy {
  /** First-in-first-out by creation time. */
  FIFO = "fifo",
  /** Highest priority first (default). */
  PRIORITY = "priority",
  /** Earliest deadline first. */
  DEADLINE = "deadline",
}

/** A schedulable unit of work. */
export interface Task {
  id: string;
  room: string;
  name: string;
  command: string;
  args: string[];
  /** Higher dispatches first. */
  priority: number;
  /** Absolute epoch seconds, or null for no deadline. */
  deadline: number | null;
  /** Seconds between recurrences, or 0 for one-shot. */
  recurringInterval: number;
  state: TaskState;
  /** Token budget this task needs (0 = unbudgeted). */
  tokensBudget: number;
  tokensUsed: number;
  retryCount: number;
  maxRetries: number;
  resultSummary: string;
  /** Epoch seconds before which the task is not eligible (retry backoff). */
  availableAt: number | null;
  createdAt: number;
  updatedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
}

export interface SubmitOptions {
  room?: string;
  command?: string;
  args?: string[];
  priority?: number;
  /** Token budget the task needs from its room's daily allowance. */
  tokensBudget?: number;
  /** Absolute epoch seconds. */
  deadline?: number | null;
  /** Seconds between recurrences; 0 = one-shot. */
  recurringInterval?: number;
  maxRetries?: number;
}

export interface SchedulerOptions {
  /** Explicit DB path or ":memory:". */
  db?: string;
  /** Alias for `db` (SPEC_TS.md uses `dbPath`). */
  dbPath?: string;
  /** Derive the DB path from an Environment instead. */
  env?: Environment;
  policy?: SchedulingPolicy;
  /** Injectable clock returning epoch seconds (for tests). */
  clock?: () => number;
}

export interface QueueStats {
  counts: Record<string, number>;
  budgets: Record<string, { limit: number; used: number; remaining: number }>;
  heapSize: number;
}

// ── Internal binary min-heap (comparator-based) ──────────────────────────────

type Comparator<T> = (a: T, b: T) => number;

/** A small binary min-heap. `compare(a, b) < 0` ⇒ `a` dequeues before `b`. */
class BinaryHeap<T> {
  private items: T[] = [];
  constructor(private compare: Comparator<T>) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop() as T;
    if (n > 1) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  clear(): void {
    this.items = [];
  }

  /** Re-heapify with a (possibly new) comparator — used on policy change. */
  rebuild(compare?: Comparator<T>): void {
    if (compare) this.compare = compare;
    const arr = this.items;
    this.items = [];
    for (const x of arr) this.push(x);
  }

  private bubbleUp(i: number): void {
    const item = this.items[i] as T;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = this.items[parent] as T;
      if (this.compare(item, p) >= 0) break;
      this.items[i] = p;
      i = parent;
    }
    this.items[i] = item;
  }

  private bubbleDown(i: number): void {
    const n = this.items.length;
    const item = this.items[i] as T;
    for (;;) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.compare(this.items[left] as T, this.items[smallest] as T) < 0) {
        smallest = left;
      }
      if (right < n && this.compare(this.items[right] as T, this.items[smallest] as T) < 0) {
        smallest = right;
      }
      if (smallest === i) break;
      this.items[i] = this.items[smallest] as T;
      i = smallest;
    }
    this.items[i] = item;
  }
}

function comparatorFor(policy: SchedulingPolicy): Comparator<Task> {
  const byId = (a: Task, b: Task) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  switch (policy) {
    case SchedulingPolicy.FIFO:
      return (a, b) => a.createdAt - b.createdAt || byId(a, b);
    case SchedulingPolicy.DEADLINE:
      return (a, b) => {
        const da = a.deadline ?? Number.POSITIVE_INFINITY;
        const db = b.deadline ?? Number.POSITIVE_INFINITY;
        return da - db || b.priority - a.priority || a.createdAt - b.createdAt || byId(a, b);
      };
    case SchedulingPolicy.PRIORITY:
    default:
      return (a, b) => b.priority - a.priority || a.createdAt - b.createdAt || byId(a, b);
  }
}

// ── SQLite schema ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 0,
    deadline REAL,
    recurring_interval INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'queued',
    tokens_budget INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    result_summary TEXT NOT NULL DEFAULT '',
    available_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    dispatched_at REAL,
    completed_at REAL
);

CREATE TABLE IF NOT EXISTS task_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    timestamp REAL NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS room_budgets (
    room TEXT PRIMARY KEY,
    daily_token_limit INTEGER NOT NULL DEFAULT 500000,
    tokens_used_today INTEGER NOT NULL DEFAULT 0,
    last_reset_date TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
`;

interface TaskRow {
  id: string;
  room: string;
  name: string;
  command: string;
  args: string;
  priority: number;
  deadline: number | null;
  recurring_interval: number;
  state: string;
  tokens_budget: number;
  tokens_used: number;
  retry_count: number;
  max_retries: number;
  result_summary: string;
  available_at: number | null;
  created_at: number;
  updated_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    room: r.room,
    name: r.name,
    command: r.command,
    args: JSON.parse(r.args) as string[],
    priority: r.priority,
    deadline: r.deadline,
    recurringInterval: r.recurring_interval,
    state: r.state as TaskState,
    tokensBudget: r.tokens_budget,
    tokensUsed: r.tokens_used,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
    resultSummary: r.result_summary,
    availableAt: r.available_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dispatchedAt: r.dispatched_at,
    completedAt: r.completed_at,
  };
}

function localDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export class Scheduler {
  private readonly db: Database;
  private readonly clock: () => number;
  private readonly roomDailyLimit: number;
  private _policy: SchedulingPolicy;
  private heap: BinaryHeap<Task>;
  private idCounter = 0;

  constructor(options: SchedulerOptions = {}) {
    const path = resolveDbPath(options);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA_SQL);

    this.clock = options.clock ?? (() => Date.now() / 1000);
    this._policy = options.policy ?? SchedulingPolicy.PRIORITY;
    this.roomDailyLimit = options.env
      ? options.env.config.defaultRoomDailyLimit
      : 500_000;
    this.heap = new BinaryHeap<Task>(comparatorFor(this._policy));
    this.loadFromDb();
  }

  get policy(): SchedulingPolicy {
    return this._policy;
  }
  set policy(p: SchedulingPolicy) {
    this._policy = p;
    this.heap.rebuild(comparatorFor(p));
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  private loadFromDb(): void {
    const rows = this.db
      .query(
        "SELECT * FROM tasks WHERE state IN ('queued', 'dispatched') " +
          "ORDER BY priority DESC, created_at ASC",
      )
      .all() as TaskRow[];
    for (const row of rows) {
      const task = rowToTask(row);
      // A task caught mid-dispatch by a crash is re-queued for re-execution.
      if (task.state === TaskState.DISPATCHED) task.state = TaskState.QUEUED;
      this.heap.push(task);
    }
  }

  private saveTask(task: Task): void {
    task.updatedAt = this.clock();
    this.db
      .query(
        `INSERT INTO tasks
           (id, room, name, command, args, priority, deadline, recurring_interval,
            state, tokens_budget, tokens_used, retry_count, max_retries,
            result_summary, available_at, created_at, updated_at,
            dispatched_at, completed_at)
         VALUES ($id, $room, $name, $command, $args, $priority, $deadline,
            $recurring_interval, $state, $tokens_budget, $tokens_used,
            $retry_count, $max_retries, $result_summary, $available_at,
            $created_at, $updated_at, $dispatched_at, $completed_at)
         ON CONFLICT(id) DO UPDATE SET
            state = excluded.state, priority = excluded.priority,
            tokens_used = excluded.tokens_used, retry_count = excluded.retry_count,
            result_summary = excluded.result_summary,
            available_at = excluded.available_at, updated_at = excluded.updated_at,
            dispatched_at = excluded.dispatched_at,
            completed_at = excluded.completed_at`,
      )
      .run({
        $id: task.id,
        $room: task.room,
        $name: task.name,
        $command: task.command,
        $args: JSON.stringify(task.args),
        $priority: task.priority,
        $deadline: task.deadline,
        $recurring_interval: task.recurringInterval,
        $state: task.state,
        $tokens_budget: task.tokensBudget,
        $tokens_used: task.tokensUsed,
        $retry_count: task.retryCount,
        $max_retries: task.maxRetries,
        $result_summary: task.resultSummary,
        $available_at: task.availableAt,
        $created_at: task.createdAt,
        $updated_at: task.updatedAt,
        $dispatched_at: task.dispatchedAt,
        $completed_at: task.completedAt,
      });
  }

  private logEvent(taskId: string, event: string, detail = ""): void {
    this.db
      .query(
        "INSERT INTO task_log (task_id, timestamp, event, detail) VALUES (?, ?, ?, ?)",
      )
      .run(taskId, this.clock(), event, detail);
  }

  // ── Token budget (per-room, daily) ─────────────────────────────────────--
  private resetDailyBudget(room: string): void {
    const today = localDate(this.clock());
    const row = this.db
      .query("SELECT last_reset_date FROM room_budgets WHERE room = ?")
      .get(room) as { last_reset_date: string } | null;
    if (row && row.last_reset_date === today) return;
    this.db
      .query(
        `INSERT INTO room_budgets (room, daily_token_limit, tokens_used_today, last_reset_date)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(room) DO UPDATE SET tokens_used_today = 0, last_reset_date = ?`,
      )
      .run(room, this.roomDailyLimit, today, today);
  }

  private budgetExceeded(room: string, taskTokens: number): boolean {
    this.resetDailyBudget(room);
    const row = this.db
      .query(
        "SELECT daily_token_limit, tokens_used_today FROM room_budgets WHERE room = ?",
      )
      .get(room) as { daily_token_limit: number; tokens_used_today: number } | null;
    if (!row) return false;
    return row.tokens_used_today + taskTokens > row.daily_token_limit;
  }

  private spendTokens(room: string, tokens: number): void {
    this.resetDailyBudget(room);
    this.db
      .query(
        "UPDATE room_budgets SET tokens_used_today = tokens_used_today + ? WHERE room = ?",
      )
      .run(tokens, room);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  /** Enqueue a new task. Returns the task id. */
  submit(name: string, options: SubmitOptions = {}): string {
    const now = this.clock();
    const id = this.newTaskId(name);
    const task: Task = {
      id,
      room: options.room ?? "",
      name,
      command: options.command ?? "",
      args: options.args ?? [],
      priority: options.priority ?? 0,
      deadline: options.deadline ?? null,
      recurringInterval: options.recurringInterval ?? 0,
      state: TaskState.QUEUED,
      tokensBudget: options.tokensBudget ?? 0,
      tokensUsed: 0,
      retryCount: 0,
      maxRetries: options.maxRetries ?? 3,
      resultSummary: "",
      availableAt: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
      completedAt: null,
    };
    this.heap.push(task);
    this.saveTask(task);
    this.logEvent(id, "queued", `room=${task.room} priority=${task.priority}`);
    return id;
  }

  /** Cancel a queued task. Returns true if a cancellable task was found. */
  cancel(taskId: string): boolean {
    // Rebuild the heap without the target (heaps have no random delete).
    let found = false;
    const remaining: Task[] = [];
    let popped: Task | undefined;
    while ((popped = this.heap.pop()) !== undefined) {
      if (popped.id === taskId) {
        found = true;
        popped.state = TaskState.CANCELLED;
        this.saveTask(popped);
        this.logEvent(taskId, "cancelled");
      } else {
        remaining.push(popped);
      }
    }
    for (const t of remaining) this.heap.push(t);
    if (found) return true;

    // Not in the heap — cancel a persisted queued/dispatched task directly.
    const row = this.db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(taskId) as { state: string } | null;
    if (row && (row.state === "queued" || row.state === "dispatched")) {
      this.db.query("UPDATE tasks SET state = 'cancelled' WHERE id = ?").run(taskId);
      this.logEvent(taskId, "cancelled", "via DB");
      return true;
    }
    return false;
  }

  /** Fetch a single task by id, or null. */
  getTask(taskId: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | null;
    return row ? rowToTask(row) : null;
  }

  /** List tasks, optionally filtered by state. */
  listTasks(state?: TaskState | string): Task[] {
    const rows = state
      ? (this.db
          .query(
            "SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC",
          )
          .all(String(state)) as TaskRow[])
      : (this.db
          .query("SELECT * FROM tasks ORDER BY state, priority DESC, created_at ASC")
          .all() as TaskRow[]);
    return rows.map(rowToTask);
  }

  /** Summary counts + per-room budgets + current heap size. */
  queueStats(): QueueStats {
    const counts: Record<string, number> = {};
    for (const s of Object.values(TaskState)) {
      const row = this.db
        .query("SELECT COUNT(*) AS n FROM tasks WHERE state = ?")
        .get(s) as { n: number };
      counts[s] = row.n;
    }
    const budgets: QueueStats["budgets"] = {};
    const rows = this.db
      .query(
        "SELECT room, daily_token_limit, tokens_used_today FROM room_budgets",
      )
      .all() as Array<{ room: string; daily_token_limit: number; tokens_used_today: number }>;
    for (const r of rows) {
      budgets[r.room] = {
        limit: r.daily_token_limit,
        used: r.tokens_used_today,
        remaining: r.daily_token_limit - r.tokens_used_today,
      };
    }
    return { counts, budgets, heapSize: this.heap.size };
  }

  /**
   * Process at most one task: select the next eligible task, execute it, and
   * handle retry/recurrence. Returns the number of tasks processed (0 or 1).
   */
  runOnce(): number {
    const task = this.popNext();
    if (task === null) return 0;
    const success = this.execute(task);
    this.handleCompletion(task, success);
    return 1;
  }

  close(): void {
    this.db.close();
  }

  // ── Selection / execution ──────────────────────────────────────────────--
  private popNext(): Task | null {
    // Rebuild from SQLite if the in-memory queue drained (crash recovery / new
    // tasks persisted by another instance).
    if (this.heap.size === 0) this.loadFromDb();

    const deferred: Task[] = [];
    let chosen: Task | null = null;
    let task: Task | undefined;
    while ((task = this.heap.pop()) !== undefined) {
      const now = this.clock();

      // Expired deadline → fail and skip.
      if (task.deadline != null && task.deadline < now) {
        task.state = TaskState.FAILED;
        task.resultSummary = "deadline expired";
        task.completedAt = now;
        this.saveTask(task);
        this.logEvent(task.id, "deadline_expired");
        continue;
      }

      // Retry backoff not elapsed → not yet eligible; try the next task.
      if (task.availableAt != null && now < task.availableAt) {
        deferred.push(task);
        continue;
      }

      // Budget would be exceeded → head-of-line block (see file header).
      if (task.tokensBudget > 0 && this.budgetExceeded(task.room, task.tokensBudget)) {
        this.heap.push(task);
        for (const d of deferred) this.heap.push(d);
        return null;
      }

      chosen = task;
      break;
    }

    for (const d of deferred) this.heap.push(d);
    return chosen;
  }

  private execute(task: Task): boolean {
    const start = this.clock();
    task.state = TaskState.RUNNING;
    task.dispatchedAt = start;
    this.saveTask(task);
    this.logEvent(task.id, "dispatched");

    if (!task.command) {
      // Pure internal task: completes without running anything and (matching the
      // prototype) without consuming room budget — only real commands spend.
      task.state = TaskState.COMPLETED;
      task.completedAt = this.clock();
      task.resultSummary = "no-op (no command)";
      this.saveTask(task);
      this.logEvent(task.id, task.state, task.resultSummary);
      return true;
    }

    const argv = [task.command, ...task.args].filter((a) => a !== "");
    const timeoutSec = task.deadline ? Math.max(1, task.deadline - this.clock()) : 300;
    try {
      const result = Bun.spawnSync(argv, { timeout: Math.round(timeoutSec * 1000) });
      if (result.exitCode === 0) {
        task.state = TaskState.COMPLETED;
        task.resultSummary = result.stdout.toString().trim().slice(0, 200) || "ok";
      } else if (result.exitCode === null && result.signalCode) {
        // Killed by our timeout (or a signal): treat as timeout failure.
        task.state = TaskState.FAILED;
        task.resultSummary = "timeout";
      } else {
        task.state = TaskState.FAILED;
        task.resultSummary =
          result.stderr.toString().trim().slice(0, 200) || `exit code ${result.exitCode}`;
      }
    } catch (err) {
      task.state = TaskState.FAILED;
      const code = (err as { code?: string }).code;
      task.resultSummary =
        code === "ENOENT"
          ? `command not found: ${task.command}`
          : String((err as Error).message ?? err).slice(0, 200);
    }

    task.completedAt = this.clock();
    this.saveTask(task);
    this.logEvent(task.id, task.state, task.resultSummary);

    if (task.tokensBudget > 0) this.spendTokens(task.room, task.tokensBudget);
    return task.state === TaskState.COMPLETED;
  }

  private handleCompletion(task: Task, success: boolean): void {
    if (!success && task.retryCount < task.maxRetries) {
      task.retryCount += 1;
      task.state = TaskState.QUEUED;
      task.dispatchedAt = null;
      task.completedAt = null;
      const wait = Math.min(2 ** task.retryCount, 60);
      task.availableAt = this.clock() + wait;
      task.priority -= 1; // genuinely lower priority on retry (see file header)
      this.saveTask(task);
      this.logEvent(
        task.id,
        "retry",
        `attempt ${task.retryCount}/${task.maxRetries}, wait ${wait}s`,
      );
      this.heap.push(task);
    }

    if (task.recurringInterval > 0 && task.state !== TaskState.CANCELLED) {
      const now = this.clock();
      const next: Task = {
        ...task,
        id: this.newTaskId(task.name),
        state: TaskState.QUEUED,
        deadline: task.deadline != null ? task.deadline + task.recurringInterval : null,
        tokensUsed: 0,
        retryCount: 0,
        resultSummary: "",
        availableAt: null,
        createdAt: now,
        updatedAt: now,
        dispatchedAt: null,
        completedAt: null,
      };
      this.heap.push(next);
      this.saveTask(next);
      this.logEvent(next.id, "recurring_enqueued", `next deadline: ${next.deadline}`);
    }
  }

  private newTaskId(name: string): string {
    // Includes a process-local counter so a fixed/coarse clock cannot collide
    // (the Python prototype hashed name+timestamp only and could collide).
    const raw = `${name}:${this.clock()}:${this.idCounter++}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }
}

function resolveDbPath(options: SchedulerOptions): string {
  if (options.db) return options.db;
  if (options.dbPath) return options.dbPath;
  if (options.env) return options.env.schedulerDb;
  return Environment.load().schedulerDb;
}
