/**
 * db.ts — INTERNAL: process-wide SQLite connection cache.
 *
 * The hypervisor's budget and audit gates are read-modify-write paths that MUST
 * observe their own prior writes immediately. The original "open a connection
 * per call" pattern (open → write → close → reopen) exposed a WAL
 * cross-connection visibility race: under concurrent load a committed write was
 * not reliably visible to the next freshly-opened connection's read, so a budget
 * debit could be lost and the gate could fail OPEN — allowing an overspend. A
 * gate that fails open even occasionally is disqualifying, so the per-call
 * pattern is removed at the root.
 *
 * Fix: one long-lived connection per database file, cached by absolute path, so
 * every in-process budget/audit operation shares a single connection. A write is
 * therefore always visible to the next read in-process. The connection is opened
 * once (`init` runs once: WAL + busy_timeout + schema) and reused for the process
 * lifetime. Combined with the IMMEDIATE-transaction debit in {@link
 * CompactionEngine.trySpend}, the budget gate is correct under concurrency.
 *
 * `:memory:` databases are NEVER cached: each in-memory database is a distinct,
 * private store (a shared cache key would alias unrelated engines), so a caller
 * that passes ":memory:" always gets a fresh, owned connection that it must close.
 */
import { Database } from "bun:sqlite";

/** Cached connections, keyed by absolute database path. */
const cache = new Map<string, Database>();

/** Paths that are safe to share via the long-lived cache (real files only). */
function isShareable(path: string): boolean {
  return path !== "" && path !== ":memory:" && !path.startsWith("file::memory:") && !path.includes("mode=memory");
}

/** A connection plus whether the caller owns it (and so must close it). */
export interface OpenedDb {
  db: Database;
  /** True when the connection is the long-lived cached one (do NOT close it). */
  shared: boolean;
}

/**
 * Return a connection for `path`. For a real file path the connection is cached
 * and reused for the process lifetime; `init` runs exactly once, on first open.
 * For ":memory:" a fresh, uncached connection is returned and `init` runs on it
 * each time.
 *
 * The returned {@link OpenedDb.shared} flag tells the caller whether it is
 * borrowing the cached connection (must NOT close it) or owns a private one
 * (must close it when done).
 */
export function openDb(path: string, init: (db: Database) => void): OpenedDb {
  if (!isShareable(path)) {
    const db = new Database(path);
    init(db);
    return { db, shared: false };
  }
  let db = cache.get(path);
  if (db === undefined) {
    db = new Database(path);
    init(db);
    cache.set(path, db);
  }
  return { db, shared: true };
}

/**
 * Close and forget every cached connection. Intended for test teardown and
 * process shutdown — never call it mid-operation, as outstanding engines holding
 * a shared connection would then be reading a closed handle.
 */
export function closeAllDbs(): void {
  for (const db of cache.values()) {
    try {
      db.close();
    } catch {
      // already closed / file removed — nothing to do
    }
  }
  cache.clear();
}

/** Number of cached connections (test/diagnostic helper). */
export function cachedDbCount(): number {
  return cache.size;
}
