# Phase 3 — Hypervisor Primitives (builder notes for the re-gate)

Five in-process primitives that make the execSync bridge unnecessary. Each ships
with its own test file; `hypervisor.test.ts` exercises the chain + the dashboard
WebSocket event push.

| Module | Public surface |
|--------|----------------|
| `spawn.ts` | `spawn(command, args, opts) → HarborChildProcess`, `awaitExit`, `listActiveSpawns`, `SpawnTimeoutError` |
| `budget.ts` | `checkBudget`, `spendBudget`, `BudgetExceededError`, `BudgetResult` |
| `gate.ts` | `gate(toolName, fn)`, `setGateContext`, `currentGateContext`, `AccessDeniedError` |
| `audit.ts` | `audit.{allow,deny,recent,denialsToday}`, `onHypervisorEvent`/`emitHypervisorEvent` (event bus) |
| `evict.ts` | `evict.{lru,retrieve,stats}` |

All are re-exported from `index.ts` (acceptance: importable from `harbor`) and
have `package.json` subpath exports (`harbor/spawn`, `harbor/budget`, …).

## Spec-silent behaviors resolved from the Python prototype

Per the Behavioral-Fidelity Rule (consult the prototype, write a test, implement):

- **Budget check semantics** — `agent_env/compaction.py` `can_load()` and the
  execSync bridge `skill-accessor.ts#checkAccess` both deny on a pure
  `remaining >= tokens` test and do **not** evict on a denied load. `checkBudget`
  mirrors this (pure read), and `spendBudget` re-enforces the same gate before
  debiting — so a caller that skips the check still cannot overspend, and prior
  context is never silently evicted to absorb a new spend.
- **Eviction thresholds** — inherited from `CompactionEngine` (Phase 1, pinned
  from `compaction.py`: evict toward 60% once past 85%; `targetTokens` frees at
  least that many). `evict.lru` is a thin front door; behavior is unchanged.
- **Retrieve does not reload** — `compaction.py` `retrieve_from_archive` returns
  archived content without re-spending budget. `evict.retrieve` preserves that.
- **Audit denial counting** — `isolation.py` `audit_denials_today` counts rows
  with `decision = 'denied'` since UTC midnight, optionally room-scoped.
  `audit.denialsToday` delegates to the Phase 1 query unchanged.
- **Gate = capability + room-skill** — `isolation.py` `require_capability` only
  records *denials* (successful loads are tracked through the budget/session
  path). `gate()` matches: it auto-audits denials (capability denial via
  `AgentSession.check`, room-skill denial via `audit.deny`) and does not audit
  allows.

## SPEC_TS additions with NO Python reference

The spec (§3) is the reference for these; tests assert the behavior it describes:

- **`spawn.ts` (process ownership)** — the prototype's `scheduler.py` only does
  one-shot `subprocess.run` per task (fire-and-forget). It never owns a
  long-lived agent process carrying a budget, session, timeout, and env-var
  identity. `spawn()` is new: PID ownership, `AGENT_ENV_ROOM`/`AGENT_ENV_SESSION`
  injection, in-process wall-clock timeout (→ `exitCode -1`), and a session
  created/destroyed with the process.
- **`gate()` as an in-process wrapper** — the prototype gated cooperatively
  across the execSync bridge. A `gate(toolName, fn)` wrapper that any tool
  function composes, with ambient session context, is a TS-native construct.
- **In-process hypervisor event bus** (`onHypervisorEvent`/`emitHypervisorEvent`)
  — there was no real-time event channel in the prototype (the Python dashboard
  polled). Phase 2 established the `/api/live` WebSocket; Phase 3 fills it: every
  primitive emits a typed `HypervisorEvent` and the dashboard broadcasts them.

## Design decisions worth a reviewer's eye

- **Budget store reconciliation.** `spawn` records the session in the
  SessionTracker (sessions.db — the dashboard's history view) **and** seeds the
  CompactionEngine budget row (compaction.db — the authoritative live budget that
  `budget.ts` enforces). `HarborChildProcess.tokensUsed`/`budgetRemaining` read
  the compaction store, so as the child spends via `spendBudget`, its metadata
  auto-updates (spec §3.1). The two stores are intentionally distinct; unifying
  them is out of Phase 3 scope.
- **`HarborChildProcess` wraps (not extends) `Bun.Subprocess`.** A wrapper is
  required to normalize `exitCode` to `-1` on a Harbor-enforced timeout (Bun's
  native `exitCode` is read-only and `null` after a kill). The raw subprocess is
  exposed via `.subprocess` as an escape hatch; `pid`/`exited`/`exitCode`/`kill`/
  `stdout`/`stderr` are delegated.
- **Honest enforcement.** `allowedPaths` is a *logical* sandbox descriptor
  (metadata + `AGENT_ENV_ALLOWED_PATHS` for the child's own tool layer). It is
  NOT OS-level confinement in v1 — no bwrap/seccomp. The event bus is in-process,
  not cross-process IPC. Both documented in the module headers (BUILD_BRIEF §6).
- **`spawn` tests use throwaway processes only** — `echo`/`sh`/`true`/`sleep`
  under temp-dir envs. Nothing live, no network, no ports, no live-machine state.

## CLI + dashboard (Phase 2 integration)

- New subcommands: `harbor spawn … -- <cmd>`, `harbor budget check|spend`,
  `harbor gate <room> <tool> [resource]`, `harbor audit recent|denials`.
- Dashboard: `/api/hypervisor` (active spawns, in-process), a Hypervisor panel,
  and a live event feed driven by the `/api/live` WebSocket.

De-personalization: the `src/` scan is clean — no absolute home paths, user
emails, secrets, or machine/room slugs — and the absolute build-repo path does
not appear anywhere in the tree.

## Re-gate fix — SQLite WAL cross-connection race (budget gate fail-open)

The independent audit found a NO-GO: under concurrent load the budget gate could
**fail OPEN** and allow an overspend. Root cause: `budget.ts`/`audit.ts` resolved
the live store through Phase-1 `compaction.ts`/`isolation.ts`, which used an
**open-per-call** `bun:sqlite` pattern (open → write → close → reopen). With
genuinely concurrent connections, a debit committed on one connection was not
reliably reflected in the next connection's read-modify-write, so two spenders
could both read the same pre-spend total and both commit — overspending the limit.

Root fix (two parts):

1. **One long-lived connection per database, cached by absolute path**
   (`src/db.ts` `openDb`/`closeAllDbs`). `compaction.ts` and `isolation.ts` (audit
   log) now borrow the cached connection instead of opening per call, so a write
   is immediately visible to the next read in-process. `:memory:` stays private
   (never cached). `CompactionEngine.close()` only closes a private connection;
   the shared one is owned by the cache. `busy_timeout` is now set **before**
   `journal_mode=WAL` (a concurrent first-open otherwise fails with
   `SQLITE_BUSY_RECOVERY` before the timeout applies).

2. **Atomic, serialized budget debit** (`CompactionEngine.trySpend`, used by
   `spendBudget`). The read-check-write runs inside a single `BEGIN IMMEDIATE`
   transaction and re-reads the authoritative usage (registry sum) inside the
   lock, so concurrent spenders serialize and the gate cannot be raced into an
   overspend. Semantics are unchanged (allow iff `used + tokens <= limit`, no
   eviction on a denied spend; same-key re-spend debits net).

Regression guard: `concurrency.test.ts` drives interleaved
`spendBudget`/`checkBudget`/`audit.deny` from 8 concurrent **processes**
(`concurrency.worker.ts`; separate processes, not Worker threads, to model
genuine concurrent connections and to avoid a Bun allocator double-free on Worker
isolate teardown) and asserts: usage never exceeds the limit, no lost writes, and
every denial lands. RED on the pre-fix tree (overspend, `finalUsed` 1100–1300 vs a
1000 limit); GREEN after.
