# Phase 1 (Core) — Builder Handoff Notes

Build of the six Phase 1 modules per `phases/01-core.md` + `BUILD_BRIEF.md`.
Reference prototype: the Python package at `agent-environment/agent_env/`.

**Status:** complete and self-verified. `bun test` → 88 pass / 0 fail across 7 files;
`tsc --noEmit` clean; de-personalization scan clean. Not committed (per the
commit-only-when-asked rule) — the working tree is ready for the Gate 1 review.

## How to verify

```bash
cd "Harbor Typescript"
bun install
bun test           # 88 pass
bun run typecheck  # tsc --noEmit, no errors
# de-personalization (must print nothing):
grep -rnE "/Users/|/home/[a-z]|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" src/
```

## Modules

| Module | File | Tests |
|--------|------|-------|
| Config | `src/config.ts` | `config.test.ts` |
| Environment | `src/env.ts` | `env.test.ts` |
| Scheduler | `src/scheduler.ts` | `scheduler.test.ts` |
| Compaction | `src/compaction.ts` | `compaction.test.ts` |
| Isolation | `src/isolation.ts` | `isolation.test.ts` |
| Session tracker | `src/session.ts` | `session.test.ts` |
| (all four SQLite schemas) | — | `schema.test.ts` |

`src/index.ts` re-exports the full public surface. Only one runtime dependency
(`smol-toml`); the priority queue is a small internal binary heap (no external
dep) so the security surface stays minimal.

## Behavioral-fidelity deviations (BUILD_BRIEF §4)

Each is a *clear prototype bug* fixed per the rule "document it and handle it
correctly in TS," and each is pinned by a test that fails if reverted.

1. **Compaction — session-reload double-count.** The prototype read `tokens_used`
   from the budget row *and then* added every restored registry entry on top, so
   reloading a session inflated usage. v1 recomputes `tokensUsed` from the
   restored loaded entries (authoritative) and reconciles the budget row.
   Test: `compaction.test.ts › session reload`.
2. **Compaction — same-key reload double-count.** `load(k, …)` twice added tokens
   without debiting the prior entry. v1 debits the old entry first.
   Test: `compaction.test.ts › re-loading the same key…`.
3. **Scheduler — retry priority sign bug.** The prototype intended "lower priority
   on retry" but decremented a *negated* heap key, which *raised* effective
   priority. v1 stores priority un-negated, so the decrement lowers it as intended.
   Test: `scheduler.test.ts › retry … lowers priority`.
4. **Scheduler — blocking retry backoff.** The prototype `time.sleep()`-ed the whole
   scheduler during backoff. v1 stamps `available_at = now + min(2^retry, 60)`
   (non-blocking); the task simply isn't eligible until then, so unrelated ready
   tasks still run. Test: `scheduler.test.ts › retry with exponential backoff`.
5. **Scheduler — unwired policies.** FIFO/DEADLINE were declared but `_pop_next`
   ignored them. v1 implements all three comparators. Tests: `ordering policies`.
6. **Task/session id collisions.** Prototype ids hashed `name+timestamp` and could
   collide under a coarse clock. v1 adds a process-local counter to the hash.
   Test: `scheduler.test.ts › distinct ids under a frozen clock`.

Preserved prototype behaviors (faithful, pinned by tests, not "fixed"):
- **Budget exhaustion is head-of-line blocking** — a budget-blocked top task stalls
  the queue rather than letting lower tasks jump it (`token budget enforcement`).
- **No-op tasks (no command) do not spend room budget** — only real commands debit
  (`spending accumulates…`).
- **`activeSession` excludes non-active sessions** — once a budget is blown the
  status flips to `budget_exceeded` and the session drops out of "active".

## De-personalization (BUILD_BRIEF §3, gate check #3)

- No `/Users/`, `/home/<user>`, emails, secrets, or this machine's project/client
  names anywhere in `src/`. Home resolves via `node:os` `homedir()`.
- The prototype's hardcoded `ROOM_CAPABILITIES` (nine machine-specific room names)
  and per-room default-budget map are **removed**. Room capabilities and budgets
  are now config-driven (`config.roomCapabilities`, `config.roomBudget`) with a
  deny-by-default baseline (`DEFAULT_CAPABILITIES = read_skill, list_skills`) and a
  generic `default_session_limit`. No room name is hardcoded.
- The data/file privilege bypass changed from `room == "devops"` to the
  `Capability.ADMIN` capability (capability-model purity + de-personalization).
- `skills.default_room` default neutralized to `"general"`.
- Universal tooling/infra dir names retained in skip/whitelist defaults (e.g.
  `.cursor`, `.vscode`, `.antigravity`, `node_modules`, `secrets`) — generic, not
  personal. New config sections added: `[budgets]` and per-room `capabilities`.

## SQLite schema contract (downstream)

`schema.test.ts` reopens each DB and asserts the tables + contract columns from
`phases/01-core.md`. Reconciliation notes:

- **scheduler.db** `tasks` is a **superset** of the contract columns (adds `name`,
  `args`, `recurring_interval`, `max_retries`, `result_summary`, `available_at`,
  `dispatched_at`, `completed_at`). Plus `task_log`, `room_budgets`.
- **compaction.db** keeps the prototype's three-table design
  (`archived_context` + `context_registry` + `session_budgets`). The contract's
  single `context_entries` sketch can't express loaded-vs-archived state, which the
  LRU-evict-then-reload behavior requires; `archived_context` is that archive. The
  typed API (`listArchive`) returns the contract field names (`key`, `tokens`,
  `tier`, …).
- **isolation.db** `audit_log` uses the contract names `decision`/`reason` and adds
  `agent_id`/`event` for fidelity.
- **sessions.db** `sessions` uses the contract names (`id`, `token_limit`,
  `skill_loads`, `denials`, …); `skill_loads`/`denials` are counted from events at
  rollup. Plus `session_events`.

## Downstream contracts delivered (for later phases)

- Phase 3 `budget.ts` → `CompactionEngine.canLoad()`, `.spend()`.
- Phase 3 `gate.ts` → `checkSkillAccess()`, `requireCapability()`.
- Phase 3 `audit.ts` → `auditLog()` / `auditRead()` / `auditDenialsToday()`.
- Phase 3 `evict.ts` → `CompactionEngine.evictLRU()`, `.retrieve()`.
- Phase 3 `spawn.ts` → `Scheduler` + `.submit()`.
- Phase 5 MCP server → `SessionTracker.start()/track()/end()`.
- All exports are named (no default exports); SQLite is internal (typed methods
  only); session context flows via arguments, not globals; fallible methods either
  throw a typed error (`ConfigError`, `BudgetError`, `AccessDenied`) or return a
  result (`{ ok, reason }`, `boolean`, `null`).

## Deliberate scope boundaries

No CLI, HTTP, daemon, or agent integrations (later phases). The scheduler exposes
`runOnce()` (the testable unit); the daemon loop is Phase 2. `loadSkillTier` reads
the index-tier description locally from `SKILL.md` frontmatter rather than pulling
the Phase 4 `skills` module.

## Implementation choices worth a reviewer's eye

- TOML parsed with `smol-toml` (BUILD_BRIEF §5). Note: Bun also ships a native
  `Bun.TOML.parse`; `smol-toml` was used as the resolved decision — flag if you'd
  prefer the zero-dependency native parser.
- Injectable `clock: () => number` (epoch seconds) on Scheduler/Compaction/Session
  makes deadlines, backoff, and daily-budget reset deterministic in tests.
- `state.json` uses the camelCase `SessionState` shape (a clean v1 format, not a
  port of the prototype's snake_case file); file writes are synchronous `node:fs`
  (the spec's `Bun.write()` is async — sync keeps the lifecycle API simple).
