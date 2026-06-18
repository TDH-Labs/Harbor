/**
 * budget.ts — HYPERVISOR: in-process token budget enforcement.
 *
 * `checkBudget` / `spendBudget` are the ONLY sanctioned path to spending a
 * session's token budget. Both are synchronous (`bun:sqlite` I/O) so an agent
 * integration calls them inline before/after a skill load — no execSync bridge.
 *
 * Behavioral fidelity (the execSync bridge `skill-accessor.ts#checkAccess` and
 * `compaction.py`, where SPEC_TS §3.2 leaves details open):
 *   - A check is a *pure* remaining-budget test (`remaining >= tokens`), matching
 *     the bridge's `tokens_used + estimated > token_budget` deny. It does NOT
 *     evict — eviction is an explicit, separate operation (`evict.ts`).
 *   - `spendBudget` re-enforces the same gate before debiting, so a caller that
 *     skips `checkBudget` still cannot overspend. On overspend it throws
 *     {@link BudgetExceededError} (no silent eviction of prior context).
 *   - Because the pre-check guarantees headroom, the underlying
 *     `CompactionEngine.spend` never evicts here.
 *
 * The session's limit is whatever the session was created with (by `spawn()` /
 * session start, persisted in `compaction.db`); the first call for an unseen
 * session may seed it via `options.tokenLimit`.
 */
import { CompactionEngine } from "./compaction.ts";
import { Environment } from "./env.ts";
import { emitHypervisorEvent } from "./audit.ts";

const nowSec = (): number => Date.now() / 1000;

/** The result of a budget check or spend. */
export interface BudgetResult {
  ok: boolean;
  limit: number;
  used: number;
  remaining: number;
  reason?: string;
}

/** Context for resolving the session's CompactionEngine. */
export interface BudgetOptions {
  /** Harbor environment (state dir). Defaults to {@link Environment.default}. */
  env?: Environment;
  /** Room label, used only when this call first creates the session budget row. */
  room?: string;
  /** Token limit, used only when this call first creates the session budget row. */
  tokenLimit?: number;
}

/** Thrown by {@link spendBudget} when a debit would exceed the session budget. */
export class BudgetExceededError extends Error {
  readonly sessionId: string;
  readonly key: string;
  readonly requested: number;
  readonly remaining: number;
  readonly limit: number;
  constructor(init: {
    sessionId: string;
    key: string;
    requested: number;
    remaining: number;
    limit: number;
  }) {
    super(
      `Budget exceeded for session '${init.sessionId}': need ${init.requested}, ` +
        `have ${init.remaining} (${init.limit - init.remaining}/${init.limit} used)`,
    );
    this.name = "BudgetExceededError";
    this.sessionId = init.sessionId;
    this.key = init.key;
    this.requested = init.requested;
    this.remaining = init.remaining;
    this.limit = init.limit;
  }
}

function engineFor(sessionId: string, options: BudgetOptions): CompactionEngine {
  return new CompactionEngine({
    env: options.env ?? Environment.default(),
    sessionId,
    room: options.room ?? "",
    ...(options.tokenLimit != null ? { tokenLimit: options.tokenLimit } : {}),
  });
}

/**
 * Check whether `tokens` can be spent under `key` without exceeding the session
 * budget. Pure read — never mutates the budget, never evicts.
 */
export function checkBudget(
  sessionId: string,
  key: string,
  tokens: number,
  options: BudgetOptions = {},
): BudgetResult {
  const engine = engineFor(sessionId, options);
  try {
    const limit = engine.tokenLimit;
    const used = engine.tokensUsed;
    const remaining = engine.remainingBudget();
    const ok = engine.canLoad(tokens);
    if (!ok) {
      emitHypervisorEvent({
        kind: "budget",
        event: "check_denied",
        sessionId,
        room: engine.room,
        resource: key,
        tokens,
        used,
        remaining,
        limit,
        timestamp: nowSec(),
      });
      return {
        ok,
        limit,
        used,
        remaining,
        reason: `budget exceeded: need ${tokens}, have ${remaining} (${used}/${limit} used)`,
      };
    }
    return { ok, limit, used, remaining };
  } finally {
    engine.close();
  }
}

/**
 * Debit `tokens` against the session budget under `key`. Throws
 * {@link BudgetExceededError} if it would exceed the limit. Returns the updated
 * {@link BudgetResult} on success.
 */
export function spendBudget(
  sessionId: string,
  key: string,
  tokens: number,
  options: BudgetOptions = {},
): BudgetResult {
  const engine = engineFor(sessionId, options);
  try {
    // Atomic check-and-debit (BEGIN IMMEDIATE inside the engine): the gate cannot
    // fail open under concurrency — a spend that would exceed the limit is denied,
    // never silently absorbed by eviction.
    const r = engine.trySpend(key, tokens);
    if (!r.ok) {
      emitHypervisorEvent({
        kind: "budget",
        event: "exceeded",
        sessionId,
        room: engine.room,
        resource: key,
        tokens,
        used: r.used,
        remaining: r.remaining,
        limit: r.limit,
        timestamp: nowSec(),
      });
      throw new BudgetExceededError({
        sessionId,
        key,
        requested: tokens,
        remaining: r.remaining,
        limit: r.limit,
      });
    }
    const result: BudgetResult = { ok: true, limit: r.limit, used: r.used, remaining: r.remaining };
    emitHypervisorEvent({
      kind: "budget",
      event: "spent",
      sessionId,
      room: engine.room,
      resource: key,
      tokens,
      used: result.used,
      remaining: result.remaining,
      limit: result.limit,
      timestamp: nowSec(),
    });
    return result;
  } finally {
    engine.close();
  }
}
