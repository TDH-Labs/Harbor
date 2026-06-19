/**
 * concurrency.worker.ts — load generator for `concurrency.test.ts`.
 *
 * Run as a SUBPROCESS (`bun concurrency.worker.ts '<job-json>'`), one per
 * concurrent "agent". Separate processes — not Worker threads — are used on
 * purpose: each has its own module state and its own SQLite connection(s), so
 * the budget and audit gates face GENUINELY concurrent connections to the same
 * database files. That is the only way to exercise the cross-connection race the
 * single-connection + IMMEDIATE-transaction fix closes (a single thread cannot
 * reproduce it: the budget calls are synchronous, so same-thread calls never
 * interleave). Separate processes also sidestep a Bun allocator double-free that
 * can occur when a Worker isolate is torn down with live `bun:sqlite` handles.
 *
 * Each process hammers `spendBudget` with distinct keys (so allowed spends
 * accumulate), interleaves an advisory `checkBudget` read, and attempts one
 * `audit.deny` per iteration, then prints its tallies as JSON on stdout.
 *
 * The generator is deliberately defensive: a budget overspend or a dropped audit
 * write must surface as a COUNT the test can assert on, never as an uncaught
 * throw that aborts the run. (Pre-fix, the open-per-call audit path throws
 * "database is locked" under this load — that is exactly a denial failing to
 * land, so it is counted, not propagated.)
 */
import { audit } from "./audit.ts";
import { BudgetExceededError, checkBudget, spendBudget } from "./budget.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";

/** Work order (passed as a JSON argv to the subprocess). */
export interface ConcurrencyJob {
  root: string;
  stateDir: string;
  sessionId: string;
  room: string;
  spend: number;
  iters: number;
  /** Per-worker namespace so keys never collide across workers. */
  keyPrefix: string;
}

/** Tally printed back to the test as JSON. */
export interface ConcurrencyResult {
  /** Spends that returned ok. */
  allowed: number;
  /** Spends cleanly denied with BudgetExceededError (the correct gate behavior). */
  denied: number;
  /** Spends that threw something other than BudgetExceededError (e.g. lock errors). */
  spendErrors: number;
  /** audit.deny attempts (one per iteration). */
  denialsAttempted: number;
  /** audit.deny calls that threw instead of recording (a dropped denial). */
  denialErrors: number;
}

/** Run one worker's load against the shared databases and return its tally. */
export function runJob(job: ConcurrencyJob): ConcurrencyResult {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: job.stateDir } }));
  const env = new Environment(job.root, cfg);

  let allowed = 0;
  let denied = 0;
  let spendErrors = 0;
  let denialsAttempted = 0;
  let denialErrors = 0;

  for (let i = 0; i < job.iters; i++) {
    // Advisory read interleaved with the writers (tolerate transient errors).
    try {
      checkBudget(job.sessionId, `${job.keyPrefix}:probe`, job.spend, { env });
    } catch {
      // a check is non-authoritative; ignore transient read failures
    }

    // Authoritative debit under a globally-unique key.
    try {
      spendBudget(job.sessionId, `${job.keyPrefix}:${i}`, job.spend, { env });
      allowed++;
    } catch (err) {
      if (err instanceof BudgetExceededError) denied++;
      else spendErrors++;
    }

    // A denial that must always land in the audit log.
    denialsAttempted++;
    try {
      audit.deny(job.sessionId, "read_skill", `${job.keyPrefix}:${i}`, "stress", {
        room: job.room,
        env,
      });
    } catch {
      denialErrors++; // a denial that failed to land (pre-fix lock under load)
    }
  }

  return { allowed, denied, spendErrors, denialsAttempted, denialErrors };
}

// Subprocess entry point: argv[2] carries the job JSON; emit the result JSON.
if (import.meta.main) {
  const raw = process.argv[2] ?? "{}";
  const result = runJob(JSON.parse(raw) as ConcurrencyJob);
  closeAllDbs();
  process.stdout.write(JSON.stringify(result));
}
