/**
 * evict.ts — HYPERVISOR: context eviction + retrieval.
 *
 * Thin, sessionId-keyed front door onto the Phase 1 `CompactionEngine`. The
 * agent runtime calls `evict.lru()` when it nears the context-window threshold;
 * evicted content is archived (not deleted) and recoverable with `retrieve()`.
 *
 * SPEC_TS §3.5 defines this primitive. Behavior is inherited from
 * `CompactionEngine` (Phase 1, behavior pinned there from `compaction.py`):
 *   - `lru()` with no `targetTokens` evicts down toward the 60% target once past
 *     the 85% threshold; with `targetTokens` it frees at least that many tokens.
 *   - `retrieve()` returns archived content WITHOUT reloading it (no budget cost).
 *   - `stats()` reports the live budget snapshot.
 */
import { CompactionEngine, type CompactionStats } from "./compaction.ts";
import { Environment } from "./env.ts";
import { emitHypervisorEvent } from "./audit.ts";

const nowSec = (): number => Date.now() / 1000;

/** Context for resolving the session's CompactionEngine. */
export interface EvictOptions {
  env?: Environment;
  room?: string;
  tokenLimit?: number;
}

/** Options for an LRU eviction pass. */
export interface EvictLruOptions extends EvictOptions {
  /** Free at least this many tokens. Omit to evict toward the 60% target. */
  targetTokens?: number;
}

/** Live budget snapshot for a session (spec §3.5 `stats`). */
export interface EvictStats {
  sessionId: string;
  room: string;
  tokenLimit: number;
  tokensUsed: number;
  remaining: number;
  budgetPercent: number;
  loadedItems: number;
  archivedCount: number;
}

function engineFor(sessionId: string, options: EvictOptions): CompactionEngine {
  return new CompactionEngine({
    env: options.env ?? Environment.default(),
    sessionId,
    room: options.room ?? "",
    ...(options.tokenLimit != null ? { tokenLimit: options.tokenLimit } : {}),
  });
}

/** Evict least-recently-used context for a session. Returns tokens freed. */
export function lru(sessionId: string, options: EvictLruOptions = {}): number {
  const engine = engineFor(sessionId, options);
  try {
    const freed = engine.evictLRU(options.targetTokens);
    if (freed > 0) {
      emitHypervisorEvent({
        kind: "budget",
        event: "evicted",
        sessionId,
        room: engine.room,
        tokens: freed,
        used: engine.tokensUsed,
        remaining: engine.remainingBudget(),
        limit: engine.tokenLimit,
        timestamp: nowSec(),
      });
    }
    return freed;
  } finally {
    engine.close();
  }
}

/** Fetch archived content for a key (latest). Does NOT reload it. Null if absent. */
export function retrieve(sessionId: string, key: string, options: EvictOptions = {}): string | null {
  const engine = engineFor(sessionId, options);
  try {
    return engine.retrieve(key);
  } finally {
    engine.close();
  }
}

/** Live budget snapshot for a session. */
export function stats(sessionId: string, options: EvictOptions = {}): EvictStats {
  const engine = engineFor(sessionId, options);
  try {
    const s: CompactionStats = engine.stats();
    return {
      sessionId: s.sessionId,
      room: s.room,
      tokenLimit: s.tokenLimit,
      tokensUsed: s.tokensUsed,
      remaining: s.tokensRemaining,
      budgetPercent: s.budgetPercent,
      loadedItems: s.loadedItems,
      archivedCount: s.archivedCount,
    };
  } finally {
    engine.close();
  }
}

/** The `evict` namespace object (spec call shape: `evict.lru(...)`). */
export const evict = { lru, retrieve, stats } as const;
