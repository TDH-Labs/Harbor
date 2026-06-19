import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { Scheduler, SchedulingPolicy, TaskState } from "./scheduler.ts";

// A controllable clock (epoch seconds) so deadline / backoff / daily-reset
// behavior is deterministic and instant.
function clockAt(start: number): { now: number; fn: () => number } {
  const state = { now: start, fn: () => 0 };
  state.fn = () => state.now;
  return state;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-sched-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function memScheduler(opts: { policy?: SchedulingPolicy; clock?: () => number } = {}) {
  return new Scheduler({ db: ":memory:", ...opts });
}

describe("basic dispatch", () => {
  test("submit + runOnce completes a no-op task", () => {
    const s = memScheduler();
    const id = s.submit("noop", { room: "ops" });
    expect(id).toBeTruthy();
    expect(s.runOnce()).toBe(1);
    expect(s.getTask(id)?.state).toBe(TaskState.COMPLETED);
    expect(s.getTask(id)?.resultSummary).toContain("no-op");
    s.close();
  });

  test("runOnce returns 0 when nothing is queued", () => {
    const s = memScheduler();
    expect(s.runOnce()).toBe(0);
    s.close();
  });

  test("a real command's stdout lands in the result summary", () => {
    const s = memScheduler();
    const id = s.submit("echo", { command: "echo", args: ["harbor-ok"] });
    s.runOnce();
    const t = s.getTask(id);
    expect(t?.state).toBe(TaskState.COMPLETED);
    expect(t?.resultSummary).toContain("harbor-ok");
    s.close();
  });

  test("a nonexistent command fails with command-not-found", () => {
    const s = memScheduler();
    const id = s.submit("bad", { command: "__no_such_cmd__", maxRetries: 0 });
    s.runOnce();
    const t = s.getTask(id);
    expect(t?.state).toBe(TaskState.FAILED);
    expect(t?.resultSummary).toContain("command not found");
    s.close();
  });

  test("submit returns distinct ids even under a frozen clock", () => {
    const c = clockAt(1000);
    const s = memScheduler({ clock: c.fn });
    const a = s.submit("dup");
    const b = s.submit("dup");
    expect(a).not.toBe(b);
    s.close();
  });
});

describe("ordering policies", () => {
  test("PRIORITY runs the highest-priority task first", () => {
    const s = memScheduler();
    const lo = s.submit("lo", { priority: 1 });
    const hi = s.submit("hi", { priority: 9 });
    s.runOnce();
    expect(s.getTask(hi)?.state).toBe(TaskState.COMPLETED);
    expect(s.getTask(lo)?.state).toBe(TaskState.QUEUED);
    s.close();
  });

  test("equal priority breaks ties FIFO by creation time", () => {
    const c = clockAt(1000);
    const s = memScheduler({ clock: c.fn });
    const first = s.submit("first");
    c.now = 1001;
    const second = s.submit("second");
    s.runOnce();
    expect(s.getTask(first)?.state).toBe(TaskState.COMPLETED);
    expect(s.getTask(second)?.state).toBe(TaskState.QUEUED);
    s.close();
  });

  test("DEADLINE policy runs the earliest deadline first regardless of priority", () => {
    const c = clockAt(1000);
    const s = memScheduler({ policy: SchedulingPolicy.DEADLINE, clock: c.fn });
    const later = s.submit("later", { priority: 9, deadline: 5000 });
    const sooner = s.submit("sooner", { priority: 1, deadline: 2000 });
    s.runOnce();
    expect(s.getTask(sooner)?.state).toBe(TaskState.COMPLETED);
    expect(s.getTask(later)?.state).toBe(TaskState.QUEUED);
    s.close();
  });
});

describe("deadlines", () => {
  test("an expired deadline fails the task and is skipped", () => {
    const c = clockAt(1000);
    const s = memScheduler({ clock: c.fn });
    const stale = s.submit("stale", { deadline: 500 }); // already past
    const fresh = s.submit("fresh", { priority: -5 }); // lower priority, valid
    s.runOnce();
    expect(s.getTask(stale)?.state).toBe(TaskState.FAILED);
    expect(s.getTask(stale)?.resultSummary).toBe("deadline expired");
    // The scheduler skipped the dead task and ran the live one.
    expect(s.getTask(fresh)?.state).toBe(TaskState.COMPLETED);
    s.close();
  });
});

describe("token budget enforcement", () => {
  function budgetedScheduler(dailyLimit: number, clock: () => number): Scheduler {
    const cfg = new Config(
      deepMerge(DEFAULTS, { budgets: { default_room_daily_limit: dailyLimit } }),
    );
    const env = new Environment(dir, cfg);
    return new Scheduler({ db: ":memory:", env, clock });
  }

  test("a task that would exceed the room's daily budget stalls the queue", () => {
    const c = clockAt(1000);
    const s = budgetedScheduler(5000, c.fn);
    const big = s.submit("big", { room: "ops", tokensBudget: 6000 });
    expect(s.runOnce()).toBe(0); // head-of-line block
    expect(s.getTask(big)?.state).toBe(TaskState.QUEUED);
    s.close();
  });

  test("spending accumulates and later blocks further dispatch", () => {
    const c = clockAt(1000);
    const s = budgetedScheduler(5000, c.fn);
    // Only tasks with a real command spend room budget (no-ops don't).
    const first = s.submit("first", { room: "ops", command: "echo", tokensBudget: 3000 });
    expect(s.runOnce()).toBe(1);
    expect(s.getTask(first)?.state).toBe(TaskState.COMPLETED);
    expect(s.queueStats().budgets.ops?.used).toBe(3000);

    const second = s.submit("second", { room: "ops", command: "echo", tokensBudget: 3000 }); // 3000+3000 > 5000
    expect(s.runOnce()).toBe(0);
    expect(s.getTask(second)?.state).toBe(TaskState.QUEUED);
    s.close();
  });
});

describe("retry with exponential backoff", () => {
  test("a failing task retries, backs off, lowers priority, and caps at maxRetries", () => {
    const c = clockAt(1000);
    const s = memScheduler({ clock: c.fn });
    const id = s.submit("flaky", { command: "false", priority: 5, maxRetries: 2 });

    // Attempt 1 fails → retry scheduled at now + 2^1 = 1002, priority 5 → 4.
    s.runOnce();
    let t = s.getTask(id);
    expect(t?.state).toBe(TaskState.QUEUED);
    expect(t?.retryCount).toBe(1);
    expect(t?.priority).toBe(4);

    // Before backoff elapses the task is not eligible.
    expect(s.runOnce()).toBe(0);

    // After backoff: attempt 2 fails → retry at 1003 + 2^2 = 1007.
    c.now = 1003;
    s.runOnce();
    t = s.getTask(id);
    expect(t?.retryCount).toBe(2);

    // After the next backoff: attempt 3 fails, but retryCount == maxRetries → no requeue.
    c.now = 1008;
    s.runOnce();
    t = s.getTask(id);
    expect(t?.state).toBe(TaskState.FAILED);
    expect(t?.retryCount).toBe(2);
    expect(s.runOnce()).toBe(0); // nothing left
    s.close();
  });
});

describe("recurring tasks", () => {
  test("a recurring task re-enqueues a fresh copy on completion", () => {
    const c = clockAt(1000);
    const s = memScheduler({ clock: c.fn });
    const id = s.submit("cron", { recurringInterval: 60 });
    s.runOnce();
    expect(s.getTask(id)?.state).toBe(TaskState.COMPLETED);

    const queued = s.listTasks(TaskState.QUEUED);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.name).toBe("cron");
    expect(queued[0]?.id).not.toBe(id); // a distinct fresh task
    s.close();
  });
});

describe("cancellation", () => {
  test("cancel removes a queued task; runOnce then does nothing", () => {
    const s = memScheduler();
    const id = s.submit("victim");
    expect(s.cancel(id)).toBe(true);
    expect(s.getTask(id)?.state).toBe(TaskState.CANCELLED);
    expect(s.runOnce()).toBe(0);
    s.close();
  });

  test("cancel returns false for an unknown task", () => {
    const s = memScheduler();
    expect(s.cancel("deadbeefdeadbeef")).toBe(false);
    s.close();
  });
});

describe("crash recovery", () => {
  test("a fresh Scheduler rebuilds its queue from SQLite", () => {
    const dbPath = join(dir, "scheduler.db");
    const a = new Scheduler({ db: dbPath });
    const id = a.submit("survivor", { room: "ops" });
    a.close(); // never ran it

    const b = new Scheduler({ db: dbPath });
    expect(b.queueStats().heapSize).toBe(1);
    expect(b.runOnce()).toBe(1);
    expect(b.getTask(id)?.state).toBe(TaskState.COMPLETED);
    b.close();
  });
});

describe("queueStats", () => {
  test("counts tasks by state", () => {
    const s = memScheduler();
    s.submit("a");
    s.submit("b");
    s.runOnce();
    const stats = s.queueStats();
    expect(stats.counts[TaskState.COMPLETED]).toBe(1);
    expect(stats.counts[TaskState.QUEUED]).toBe(1);
    s.close();
  });
});
