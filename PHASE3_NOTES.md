# Phase 3 — Hypervisor Primitives (builder notes for the re-gate)

Five in-process primitives that make the execSync bridge unnecessary. Each ships
with its own test file; `hypervisor.test.ts` exercises the chain + the dashboard
WebSocket event push.

| Module | Public surface |
|--------|----------------|
| `spawn.ts` | `spawn(command, args, opts) → HarborChildProcess`, `awaitExit`, `listActiveSpawns`, `SpawnTimeoutError` |
| `budget.ts` | `checkBudget`, `spendBudget`, `BudgetExceededError`, `BudgetResult` |
| `gate.ts` | `gate(toolName, fn)`, `runWithGateContext`, `currentGateContext`, `AccessDeniedError` |
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

## Re-gate fix #2 — gate context concurrency (capability gate fail-open)

The WAL fix above is sound and stays. The re-gate then surfaced a **separate**
flaw in the gate's context handling: the capability gate was observed failing
**OPEN** once (a marketing session's gated `read_skill` resolved instead of
denying), unreproducible in ~360 runs.

**Root cause — a mutable module-global context.** `gate()` resolved the active
session through `currentGateContext()`, which read a single process-global slot
(`explicitContext`, written by `setGateContext`). That is unsafe for concurrent
in-process sessions — the model Phase 5 (MCP server, Pi in-process import) is
built on. The wrapper reads the slot at call time; with two session handlers each
doing `setGateContext(theirCtx); … await …`, one session's context can be the
live slot value when the *other* session's gated call reads it. A capability-
denied session then evaluates against a capability-allowed session's context and
the gate **fails open**. The 1-in-360 flake (`gate.test.ts` + `hypervisor.test.ts`
sharing the global) was a sampling of exactly this production hazard.

**Design fix — per-call binding via `AsyncLocalStorage` (structural, not a
patch).** The mutable global is gone. Context is now carried by an
`AsyncLocalStorage<GateContext>`:

- `runWithGateContext(context, callback)` binds `context` for the entire async
  call chain `callback` starts; the store propagates across every `await`.
  Nested/overlapping scopes each carry their own context, so two concurrent gated
  calls for different sessions can never read each other's. There is no shared
  cell to clobber — the fail-open is **structurally impossible**, not merely
  improbable. This is the verb Phase 5 wraps each per-session request handler in.
- `currentGateContext()` reads the ALS-bound context if a scope is active, else
  falls back to the `AGENT_ENV_ROOM`/`AGENT_ENV_SESSION` env vars (the vars
  `spawn()` injects). The env-var path is documented as the *single-session-per-
  process* fallback only: env vars are process-global and cannot represent two
  identities at once, so concurrent in-process sessions MUST bind explicitly.
- `setGateContext` (the unsafe mutable-global setter) is **removed** from the
  public surface and `index.ts`; `cli.ts`, `gate.test.ts`, and `hypervisor.test.ts`
  migrate to `runWithGateContext`. Removing the global is what makes the hazard
  unreachable rather than just unlikely.

**Proving test — deterministic RED→GREEN.** `gate.test.ts` →
`gate — concurrent session context isolation` interleaves two sessions with a
rendezvous (no scheduler-timing reliance): the denied session (marketing, no
`read_skill`) parks, the allowed session (legal) sets its context and holds it
live, then the denied session fires its gated `read_skill`.

- **RED** on the module-global implementation (reproduced via a global-backed
  `runWithGateContext` shim with identical semantics to `setGateContext`):
  `expect(marketingOutcome.denied).toBe(true)` fails — the marketing call read
  legal's live context and **resolved** (`denied:false`, value `loaded:nda-review`).
  This is the observed fail-open, now deterministic instead of 1-in-360.
- **GREEN** on the ALS fix: marketing's call reads its own bound context, is
  denied, and the denial lands on marketing's ledger; legal is unaffected.

A second guard (`many interleaved chains … zero crossover`) soaks 270 chains of
all three verdict kinds (allowed / capability-denied / room-skill-denied) with
repeated yields, asserting every chain resolves against its own context.

**Root-cause note.** The deterministic interleaving *is* the root-cause
reproduction — it isolates the exact mechanism the flake sampled (a second
session's context live in the shared slot at the denied call's read), so no
runtime instrumentation of `currentGateContext()` was needed. The design fix
removes the shared slot, so the mechanism cannot occur regardless of timing.

**Test hardening + determinism.** With context now call-scoped, nothing can leak
between tests — the `afterEach(() => setGateContext(null))` resets in
`gate.test.ts` / `hypervisor.test.ts` are removed (the per-call binding is the
stronger equivalent). Full suite re-proved deterministic: **100/100 green, zero
non-green** (`bun test`, 184 tests/run, ~176s total). Typecheck clean; de-perso
scan over `src/` clean.
