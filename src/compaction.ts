/**
 * compaction.ts — Deterministic context compaction engine.
 *
 * Tracks token usage per agent session, evicts least-recently-used context when
 * the budget is exceeded, and archives evicted content to SQLite for later
 * retrieval. Supports progressive disclosure via skill compression tiers.
 *
 * Design principles (ARCHITECTURE.md):
 *   - Deterministic: token estimation is chars/4. No LLM in the eviction path.
 *   - LRU eviction: a Map preserves access order; the front is least-recent.
 *   - Archive, don't delete: evicted context goes to SQLite, retrievable later.
 *   - Tiered loading: index (~50 tokens), digest (~3K), full SKILL.md.
 *
 * Behavioral fidelity notes (BUILD_BRIEF §4) — two clear prototype bugs that
 * violated the core invariant `tokensUsed == Σ(loaded entry tokens)` are fixed
 * here and pinned by tests:
 *   1. Session reload double-counted: the prototype read `tokens_used` from the
 *      budget row *and then* added every restored registry entry on top. v1
 *      recomputes `tokensUsed` from the restored loaded entries (authoritative)
 *      and reconciles the budget row.
 *   2. Re-loading the same key double-counted: the prototype added the new
 *      token count without subtracting the old. v1 debits the old entry first.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { openDb } from "./db.ts";
import { Environment } from "./env.ts";

// ── Token estimation ─────────────────────────────────────────────────────────

/** Deterministic token count: characters / 4 (industry rule of thumb), min 1. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

// ── Types ──────────────────────────────────────────────────────────────────--

export interface ContextEntry {
  key: string;
  content: string;
  tokenCount: number;
  contentType: string;
  tier: string;
  lastAccess: number;
  metadata: Record<string, unknown>;
  archiveId: number | null;
}

export interface LoadOptions {
  contentType?: string;
  tier?: string;
  metadata?: Record<string, unknown>;
}

export interface CompactionOptions {
  sessionId: string;
  room?: string;
  tokenLimit?: number;
  db?: string;
  dbPath?: string;
  env?: Environment;
  clock?: () => number;
}

export interface CompactionStats {
  sessionId: string;
  room: string;
  tokenLimit: number;
  tokensUsed: number;
  tokensRemaining: number;
  budgetPercent: number;
  loadedItems: number;
  largestItem: number;
  archivedCount: number;
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

// ── SQLite schema ────────────────────────────────────────────────────────────
// `archived_context` is the contract's "context_entries" archive (evicted
// content, retrievable). `context_registry` tracks currently/previously loaded
// entries for budget accounting. `session_budgets` holds the per-session limit.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS archived_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    context_key TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    content_type TEXT NOT NULL DEFAULT 'text',
    tier TEXT NOT NULL DEFAULT '',
    archived_at REAL NOT NULL,
    original_size_chars INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS session_budgets (
    session_id TEXT PRIMARY KEY,
    room TEXT NOT NULL DEFAULT '',
    token_limit INTEGER NOT NULL DEFAULT 100000,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    last_access REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS context_registry (
    session_id TEXT NOT NULL,
    context_key TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT '',
    last_access REAL NOT NULL,
    is_loaded INTEGER NOT NULL DEFAULT 1,
    archive_id INTEGER,
    PRIMARY KEY (session_id, context_key)
);

CREATE INDEX IF NOT EXISTS idx_archive_session ON archived_context(session_id);
CREATE INDEX IF NOT EXISTS idx_archive_key ON archived_context(context_key);
CREATE INDEX IF NOT EXISTS idx_registry_session ON context_registry(session_id);
CREATE INDEX IF NOT EXISTS idx_registry_access ON context_registry(last_access);
`;

// ── Compaction engine ────────────────────────────────────────────────────────

export class CompactionEngine {
  static readonly DEFAULT_BUDGET = 100_000;
  static readonly EVICTION_THRESHOLD = 0.85;
  static readonly EVICTION_TARGET = 0.6;

  readonly sessionId: string;
  readonly room: string;
  private readonly db: Database;
  /** True only for a private (":memory:") connection this engine must close. */
  private readonly ownsDb: boolean;
  private readonly clock: () => number;
  private _tokenLimit: number;
  private _tokensUsed = 0;
  /** Insertion/access-ordered: first key is least-recently-used. */
  private context = new Map<string, ContextEntry>();

  constructor(options: CompactionOptions) {
    const path = resolveDbPath(options);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    // One long-lived connection per database file (shared, cached). A spend is
    // therefore immediately visible to the next budget read in-process — the
    // open-per-call WAL visibility race is gone. ":memory:" stays private.
    const opened = openDb(path, (db) => {
      // busy_timeout MUST be set before journal_mode: switching to WAL can need
      // a lock / hot-journal recovery, and without the timeout a concurrent
      // first-open fails immediately with SQLITE_BUSY_RECOVERY instead of waiting.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SCHEMA_SQL);
    });
    this.db = opened.db;
    this.ownsDb = !opened.shared;

    this.sessionId = options.sessionId;
    this.room = options.room ?? "";
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this._tokenLimit = options.tokenLimit ?? CompactionEngine.DEFAULT_BUDGET;
    this.loadSession();
  }

  // ── Session restore ────────────────────────────────────────────────────--
  private loadSession(): void {
    let row = this.db
      .query("SELECT token_limit, tokens_used FROM session_budgets WHERE session_id = ?")
      .get(this.sessionId) as { token_limit: number; tokens_used: number } | null;
    if (!row) {
      const now = this.clock();
      // Idempotent seed: a concurrent connection may have created the row first,
      // so ignore the conflict and re-read the authoritative limit rather than
      // crashing on the PRIMARY KEY.
      this.db
        .query(
          `INSERT INTO session_budgets (session_id, room, token_limit, tokens_used, created_at, last_access)
           VALUES (?, ?, ?, 0, ?, ?)
           ON CONFLICT(session_id) DO NOTHING`,
        )
        .run(this.sessionId, this.room, this._tokenLimit, now, now);
      row = this.db
        .query("SELECT token_limit, tokens_used FROM session_budgets WHERE session_id = ?")
        .get(this.sessionId) as { token_limit: number; tokens_used: number } | null;
    }
    if (row) this._tokenLimit = row.token_limit;

    const rows = this.db
      .query(
        "SELECT context_key, token_count, tier, last_access, archive_id " +
          "FROM context_registry WHERE session_id = ? AND is_loaded = 1 ORDER BY last_access",
      )
      .all(this.sessionId) as Array<{
      context_key: string;
      token_count: number;
      tier: string;
      last_access: number;
      archive_id: number | null;
    }>;

    let restored = 0;
    for (const r of rows) {
      this.context.set(r.context_key, {
        key: r.context_key,
        content: "[archived]", // content lives in the archive once evicted
        tokenCount: r.token_count,
        contentType: "text",
        tier: r.tier,
        lastAccess: r.last_access,
        metadata: {},
        archiveId: r.archive_id,
      });
      restored += r.token_count;
    }
    // Fix #1: recompute from restored entries rather than trusting + adding.
    this._tokensUsed = restored;
    this.updateBudget();
  }

  private saveRegistry(entry: ContextEntry): void {
    this.db
      .query(
        `INSERT INTO context_registry (session_id, context_key, token_count, tier, last_access, is_loaded, archive_id)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(session_id, context_key) DO UPDATE SET
           token_count = excluded.token_count, tier = excluded.tier,
           last_access = excluded.last_access, is_loaded = 1,
           archive_id = excluded.archive_id`,
      )
      .run(this.sessionId, entry.key, entry.tokenCount, entry.tier, entry.lastAccess, entry.archiveId);
  }

  private updateBudget(): void {
    this.db
      .query("UPDATE session_budgets SET tokens_used = ?, last_access = ? WHERE session_id = ?")
      .run(this._tokensUsed, this.clock(), this.sessionId);
  }

  /** Move a key to the most-recently-used position (Map re-insertion). */
  private touch(key: string, entry: ContextEntry): void {
    this.context.delete(key);
    this.context.set(key, entry);
  }

  // ── Budget queries ───────────────────────────────────────────────────────
  get tokenLimit(): number {
    return this._tokenLimit;
  }
  get tokensUsed(): number {
    return this._tokensUsed;
  }
  remainingBudget(): number {
    return Math.max(0, this._tokenLimit - this._tokensUsed);
  }
  budgetPercent(): number {
    return this._tokenLimit ? (this._tokensUsed / this._tokenLimit) * 100 : 0;
  }
  canLoad(tokens: number): boolean {
    return this.remainingBudget() >= tokens;
  }

  // ── Core operations ────────────────────────────────────────────────────--
  /**
   * Load content into the session, evicting LRU entries to make room. Throws
   * {@link BudgetError} if the budget cannot accommodate it even after eviction.
   */
  load(key: string, content: string, options: LoadOptions = {}): ContextEntry {
    const tokens = estimateTokens(content);

    // Fix #2: re-loading an existing key first debits its old token count.
    const existing = this.context.get(key);
    const netNeeded = existing ? Math.max(0, tokens - existing.tokenCount) : tokens;

    if (!this.canLoad(netNeeded)) {
      if (!this.evictToFit(netNeeded, key)) {
        throw new BudgetError(
          `Cannot load '${key}' (${tokens} tokens): ` +
            `${this.remainingBudget()}/${this._tokenLimit} remaining, no evictable entries`,
        );
      }
    }

    if (existing) this._tokensUsed -= existing.tokenCount;
    const entry: ContextEntry = {
      key,
      content,
      tokenCount: tokens,
      contentType: options.contentType ?? "text",
      tier: options.tier ?? "",
      lastAccess: this.clock(),
      metadata: options.metadata ?? {},
      archiveId: null,
    };
    this.touch(key, entry);
    this._tokensUsed += tokens;
    this.saveRegistry(entry);
    this.updateBudget();
    return entry;
  }

  /**
   * Account for `tokens` against the budget under `key` without storing content
   * (the budget-debit path used by the hypervisor's `spendBudget`). Evicts to
   * fit and throws {@link BudgetError} if it cannot.
   */
  spend(key: string, tokens: number, options: LoadOptions = {}): ContextEntry {
    const existing = this.context.get(key);
    const netNeeded = existing ? Math.max(0, tokens - existing.tokenCount) : tokens;
    if (!this.canLoad(netNeeded) && !this.evictToFit(netNeeded, key)) {
      throw new BudgetError(
        `Cannot spend ${tokens} tokens for '${key}': ` +
          `${this.remainingBudget()}/${this._tokenLimit} remaining`,
      );
    }
    if (existing) this._tokensUsed -= existing.tokenCount;
    const entry: ContextEntry = {
      key,
      content: "[tracked]",
      tokenCount: tokens,
      contentType: options.contentType ?? "tracked",
      tier: options.tier ?? "",
      lastAccess: this.clock(),
      metadata: options.metadata ?? {},
      archiveId: null,
    };
    this.touch(key, entry);
    this._tokensUsed += tokens;
    this.saveRegistry(entry);
    this.updateBudget();
    return entry;
  }

  /**
   * Atomically check-and-debit `tokens` under `key` against the session budget.
   * This is the concurrency-safe budget gate used by `spendBudget`: the entire
   * read-check-write runs inside a single `BEGIN IMMEDIATE` transaction, so two
   * spenders (even on separate connections) can never both read the same
   * pre-spend total and race each other into an overspend. The current usage is
   * re-read from the registry inside the lock — the in-memory total is never
   * trusted for the decision — so a spend committed by another connection is
   * always accounted for.
   *
   * Budget-gate semantics match the previous `spendBudget` path exactly: allow
   * iff `used + tokens <= limit`, with NO eviction (a denied spend never
   * silently evicts prior context). A re-spend of an existing key debits net of
   * its prior value. Returns the post-state and whether the spend was allowed.
   */
  trySpend(key: string, tokens: number): { ok: boolean; used: number; limit: number; remaining: number } {
    const debit = this.db.transaction(() => {
      const limit = this._tokenLimit;
      const usedRow = this.db
        .query(
          "SELECT COALESCE(SUM(token_count), 0) AS used FROM context_registry " +
            "WHERE session_id = ? AND is_loaded = 1",
        )
        .get(this.sessionId) as { used: number };
      const used = usedRow.used;
      const existingRow = this.db
        .query(
          "SELECT token_count FROM context_registry " +
            "WHERE session_id = ? AND context_key = ? AND is_loaded = 1",
        )
        .get(this.sessionId, key) as { token_count: number } | null;
      const existingTokens = existingRow ? existingRow.token_count : 0;

      // Exact gate check: the full new amount must fit against the live total.
      if (used + tokens > limit) {
        this._tokensUsed = used; // keep the in-memory view current for the caller
        return { ok: false, used, limit, remaining: Math.max(0, limit - used) };
      }

      const newUsed = used - existingTokens + tokens;
      const now = this.clock();
      const entry: ContextEntry = {
        key,
        content: "[tracked]",
        tokenCount: tokens,
        contentType: "tracked",
        tier: "",
        lastAccess: now,
        metadata: {},
        archiveId: null,
      };
      this.saveRegistry(entry);
      this.db
        .query("UPDATE session_budgets SET tokens_used = ?, last_access = ? WHERE session_id = ?")
        .run(newUsed, now, this.sessionId);
      this._tokensUsed = newUsed;
      this.touch(key, entry);
      return { ok: true, used: newUsed, limit, remaining: Math.max(0, limit - newUsed) };
    });
    // IMMEDIATE acquires the write lock up front so concurrent debits serialize
    // (waiting up to busy_timeout) instead of interleaving their read-check-write.
    return debit.immediate();
  }

  /** Retrieve a loaded entry, refreshing its LRU position. Null if not loaded. */
  get(key: string): ContextEntry | null {
    const entry = this.context.get(key);
    if (!entry) return null;
    entry.lastAccess = this.clock();
    this.touch(key, entry);
    this.saveRegistry(entry);
    return entry;
  }

  /** Evict a specific entry to the archive. Returns false if not loaded. */
  evict(key: string): boolean {
    const entry = this.context.get(key);
    if (!entry) return false;
    this.context.delete(key);
    const archiveId = this.archive(entry);
    this._tokensUsed -= entry.tokenCount;
    this.updateBudget();
    this.db
      .query(
        "UPDATE context_registry SET is_loaded = 0, archive_id = ? WHERE session_id = ? AND context_key = ?",
      )
      .run(archiveId, this.sessionId, key);
    return true;
  }

  /**
   * Evict least-recently-used entries. With no target, evicts down toward the
   * eviction target (60%) once past the threshold (85%); otherwise frees at
   * least `targetTokens`. Returns tokens freed.
   */
  evictLRU(targetTokens?: number): number {
    let targetFree: number;
    if (targetTokens === undefined) {
      const threshold = Math.floor(this._tokenLimit * CompactionEngine.EVICTION_THRESHOLD);
      if (this._tokensUsed <= threshold) return 0;
      targetFree = this._tokensUsed - Math.floor(this._tokenLimit * CompactionEngine.EVICTION_TARGET);
    } else {
      targetFree = targetTokens;
    }

    let freed = 0;
    const toEvict: string[] = [];
    for (const [key, entry] of this.context) {
      if (freed >= targetFree) break;
      toEvict.push(key);
      freed += entry.tokenCount;
    }
    for (const key of toEvict) this.evict(key);
    return freed;
  }

  private evictToFit(neededTokens: number, exceptKey?: string): boolean {
    if (this.remainingBudget() >= neededTokens) return true;
    const shortfall = neededTokens - this.remainingBudget();
    // Don't evict the key we're about to (re)load.
    this.evictLRUExcept(shortfall, exceptKey);
    return this.remainingBudget() >= neededTokens;
  }

  private evictLRUExcept(targetFree: number, exceptKey?: string): number {
    let freed = 0;
    const toEvict: string[] = [];
    for (const [key, entry] of this.context) {
      if (freed >= targetFree) break;
      if (key === exceptKey) continue;
      toEvict.push(key);
      freed += entry.tokenCount;
    }
    for (const key of toEvict) this.evict(key);
    return freed;
  }

  private archive(entry: ContextEntry): number {
    const info = this.db
      .query(
        `INSERT INTO archived_context
           (session_id, context_key, content, token_count, content_type, tier,
            archived_at, original_size_chars, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.sessionId,
        entry.key,
        entry.content,
        entry.tokenCount,
        entry.contentType,
        entry.tier,
        this.clock(),
        entry.content.length,
        JSON.stringify(entry.metadata),
      );
    return Number(info.lastInsertRowid);
  }

  /** Fetch archived content for a key (latest). Does NOT reload it. */
  retrieve(key: string): string | null {
    const row = this.db
      .query(
        "SELECT content FROM archived_context WHERE session_id = ? AND context_key = ? " +
          "ORDER BY archived_at DESC LIMIT 1",
      )
      .get(this.sessionId, key) as { content: string } | null;
    return row ? row.content : null;
  }

  /** Retrieve from the archive and reload into active context. */
  reloadFromArchive(key: string): ContextEntry | null {
    const content = this.retrieve(key);
    if (content === null) return null;
    return this.load(key, content);
  }

  listArchive(limit = 20): Array<{
    key: string;
    type: string;
    tier: string;
    tokens: number;
    archivedAt: number;
    sizeChars: number;
  }> {
    const rows = this.db
      .query(
        "SELECT context_key, content_type, tier, token_count, archived_at, original_size_chars " +
          "FROM archived_context WHERE session_id = ? ORDER BY archived_at DESC LIMIT ?",
      )
      .all(this.sessionId, limit) as Array<{
      context_key: string;
      content_type: string;
      tier: string;
      token_count: number;
      archived_at: number;
      original_size_chars: number;
    }>;
    return rows.map((r) => ({
      key: r.context_key,
      type: r.content_type,
      tier: r.tier,
      tokens: r.token_count,
      archivedAt: r.archived_at,
      sizeChars: r.original_size_chars,
    }));
  }

  stats(): CompactionStats {
    let largest = 0;
    for (const e of this.context.values()) largest = Math.max(largest, e.tokenCount);
    const archived = this.db
      .query("SELECT COUNT(*) AS n FROM archived_context WHERE session_id = ?")
      .get(this.sessionId) as { n: number };
    return {
      sessionId: this.sessionId,
      room: this.room,
      tokenLimit: this._tokenLimit,
      tokensUsed: this._tokensUsed,
      tokensRemaining: this.remainingBudget(),
      budgetPercent: Math.round(this.budgetPercent() * 10) / 10,
      loadedItems: this.context.size,
      largestItem: largest,
      archivedCount: archived.n,
    };
  }

  close(): void {
    // Only a private (":memory:") connection is owned here. The shared, cached
    // file connection is long-lived and owned by the connection cache — closing
    // it would reintroduce the open-per-call pattern (and the visibility race),
    // so a borrowed connection is left open for the next caller.
    if (this.ownsDb) this.db.close();
  }
}

// ── Skill tier loading (progressive disclosure) ──────────────────────────────

export const TIER_COSTS: Record<string, number> = {
  index: 50,
  digest: 3000,
  full: 0,
};

export type SkillTier = "index" | "digest" | "full";

/**
 * Load a skill at a compression tier into the engine. Returns null if the skill
 * (or the requested tier's source) cannot be found.
 *
 * Note: the prototype sourced the index-tier description from `skills_organize`
 * (a later-phase module). To stay within Phase 1, the description is read
 * locally from the skill's own SKILL.md frontmatter, with a first-line fallback.
 */
export function loadSkillTier(
  engine: CompactionEngine,
  env: Environment,
  skillName: string,
  tier: SkillTier = "full",
): ContextEntry | null {
  const dir = resolveSkillDir(env, skillName);
  if (dir === null) return null;
  const skillMd = join(dir, "SKILL.md");

  if (tier === "index") {
    const desc = existsSync(skillMd) ? extractDescription(readFileSync(skillMd, "utf8")) : "";
    return engine.load(`skill:${skillName}:index`, `# ${skillName}\n${desc}`, {
      contentType: "skill_index",
      tier: "index",
    });
  }

  if (tier === "digest") {
    const digestPath = join(dir, "SKILL.digest.md");
    let content: string;
    if (existsSync(digestPath)) {
      content = readFileSync(digestPath, "utf8");
    } else {
      if (!existsSync(skillMd)) return null;
      const full = readFileSync(skillMd, "utf8");
      content =
        full.length > 12000
          ? full.slice(0, 12000).replace(/\n[^\n]*$/, "") +
            "\n\n[truncated — load full tier for complete content]"
          : full;
    }
    return engine.load(`skill:${skillName}:digest`, content, {
      contentType: "skill_digest",
      tier: "digest",
    });
  }

  if (!existsSync(skillMd)) return null;
  return engine.load(`skill:${skillName}:full`, readFileSync(skillMd, "utf8"), {
    contentType: "skill_full",
    tier: "full",
  });
}

function resolveSkillDir(env: Environment, skillName: string): string | null {
  const pool = env.skillsDir;
  if (!existsSync(pool)) return null;
  const flat = join(pool, skillName);
  if (existsSync(join(flat, "SKILL.md"))) return flat;
  for (const cat of readdirSync(pool)) {
    const catDir = join(pool, cat);
    if (!statSync(catDir).isDirectory()) continue;
    const nested = join(catDir, skillName);
    if (existsSync(join(nested, "SKILL.md"))) return nested;
  }
  return null;
}

function extractDescription(skillMd: string): string {
  // YAML frontmatter `description:` first.
  const fm = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (fm && fm[1]) {
    const line = fm[1].split("\n").find((l) => l.startsWith("description:"));
    if (line) return line.slice("description:".length).trim().replace(/^["']|["']$/g, "");
  }
  // Fallback: first non-empty, non-heading line.
  for (const raw of skillMd.split("\n")) {
    const l = raw.trim();
    if (l && !l.startsWith("#") && l !== "---") return l;
  }
  return "";
}

function resolveDbPath(options: CompactionOptions): string {
  if (options.db) return options.db;
  if (options.dbPath) return options.dbPath;
  if (options.env) return options.env.compactionDb;
  return Environment.load().compactionDb;
}
