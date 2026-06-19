/**
 * concurrency.test.ts — the regression guard for the WAL cross-connection race
 * that made the budget gate fail OPEN under load (Phase 3 NO-GO).
 *
 * The hypervisor budget/audit calls are synchronous, so a single thread can
 * never interleave them — the race only appears with genuinely concurrent
 * connections to the same database files. This test drives that with Bun Workers
 * (separate threads, separate connections) hammering interleaved
 * spendBudget / checkBudget / audit.deny against ONE session budget, and asserts
 * the three security invariants:
 *
 *   1. budget never reports ALLOW past exhaustion (no overspend),
 *   2. no lost writes (every allowed spend is persisted), and
 *   3. denials always land (every audit.deny is in the log).
 *
 * Against the pre-fix open-per-call code this goes RED (workers read a stale
 * pre-spend total across connections and overspend); against the fixed code —
 * one cached connection per DB plus an IMMEDIATE-transaction debit — it is GREEN.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkBudget } from "./budget.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";
import { auditDenialsToday } from "./isolation.ts";
import type { ConcurrencyJob, ConcurrencyResult } from "./concurrency.worker.ts";

const WORKER_SCRIPT = join(import.meta.dir, "concurrency.worker.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-concur-"));
});
afterEach(() => {
  closeAllDbs(); // close cached connections before removing their backing files
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run one worker as a separate OS process (genuine concurrent connections to the
 * shared databases), returning its JSON tally.
 */
async function spawnWorker(job: ConcurrencyJob): Promise<ConcurrencyResult> {
  const proc = Bun.spawn(["bun", WORKER_SCRIPT, JSON.stringify(job)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 || out.trim() === "") {
    throw new Error(`worker exited ${code}: ${err.trim() || "(no output)"}`);
  }
  return JSON.parse(out) as ConcurrencyResult;
}

describe("budget/audit gate under concurrent connections", () => {
  const SPEND = 100;
  const LIMIT = 1000;
  const CAPACITY = LIMIT / SPEND; // exactly 10 spends fit
  const WORKERS = 8;
  const ITERS = 30; // 8×30 = 240 attempts contend for 10 slots
  const ROUNDS = 3;

  test(
    "interleaved spend/check/deny never overspends, loses writes, or drops denials",
    async () => {
      const stateDir = join(dir, ".agent-env");
      const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: stateDir } }));
      const env = new Environment(dir, cfg);

      // Warm both state DBs single-threaded so the storm hits already-existing WAL
      // files (a session's DBs exist before it spends). This keeps the test focused
      // on the spend/audit race rather than cold concurrent-first-open recovery.
      checkBudget("warm", "warm", 0, { env, tokenLimit: LIMIT });
      auditDenialsToday(env, "stress");

      let cumulativeDenials = 0;

      for (let round = 0; round < ROUNDS; round++) {
        const sessionId = `race-${round}`;
        // Seed the session's limit single-threaded, before the storm.
        checkBudget(sessionId, "seed", 0, { env, tokenLimit: LIMIT });

        const jobs: ConcurrencyJob[] = Array.from({ length: WORKERS }, (_, idx) => ({
          root: dir,
          stateDir,
          sessionId,
          room: "stress",
          spend: SPEND,
          iters: ITERS,
          keyPrefix: `r${round}w${idx}`,
        }));
        const results = await Promise.all(jobs.map(spawnWorker));

        const allowed = results.reduce((sum, r) => sum + r.allowed, 0);
        const denialsAttempted = results.reduce((sum, r) => sum + r.denialsAttempted, 0);
        const denialErrors = results.reduce((sum, r) => sum + r.denialErrors, 0);
        const spendErrors = results.reduce((sum, r) => sum + r.spendErrors, 0);
        const finalUsed = checkBudget(sessionId, "probe", 0, { env }).used;
        cumulativeDenials += denialsAttempted;

        // (1) Gate never fails OPEN: usage never exceeds the limit, and the count
        //     of allowed spends never exceeds capacity. (Pre-fix: overspend.)
        expect(finalUsed).toBeLessThanOrEqual(LIMIT);
        expect(allowed).toBeLessThanOrEqual(CAPACITY);
        // (2) No lost writes: every allowed spend is reflected in the persisted total.
        expect(allowed * SPEND).toBe(finalUsed);
        // (3) No spend should fail with anything other than a clean budget denial.
        expect(spendErrors).toBe(0);
        // With this much contention the budget fills exactly to capacity.
        expect(allowed).toBe(CAPACITY);
        // And the gate then correctly denies any further spend.
        expect(checkBudget(sessionId, "after", SPEND, { env }).ok).toBe(false);

        // (4) Denials ALWAYS land: none dropped, and every attempt is in the log.
        //     (Pre-fix: the open-per-call audit path throws under load → dropped.)
        expect(denialErrors).toBe(0);
        expect(auditDenialsToday(env, "stress")).toBe(cumulativeDenials);
      }
    },
    30_000,
  );
});
