# Phase 4 — Skill & MCP Tooling (builder notes)

Skill organization, MCP validation/generation/merge, and the skill lifecycle
(create / install / assign). Primarily CLI-driven with library exports that
Phase 5's MCP server consumes. Each module ships its own test file.

| Module | Public surface (Phase 5 contract) |
|--------|-----------------------------------|
| `skills.ts` | `listSkills(room?)`, `getSkill(name)`, `generateRoomIndexes()`, `getSkillDescription(path)` + `getAllSkillNames`, `findSkillDir`, `assignRooms`, `assignCategorizedSkills`, `computeAssignments`, `renderRoomIndex`, `generateMasterIndex` |
| `mcp.ts` | `validateServer(config)`, `generateRoomConfigs()`, `mergeConfigs(rooms[], opts)` + `validateRoom`, `validateAllRooms`, `generateRoomConfig`, `roomMcpConfig`, `roomsWithMcp`, `checkCommand`, `checkEnvVars`, `extractEnvVars`, `testConnect`, `validateServerShape` |
| `skill-create.ts` | `scaffold(name, options)` → created paths + `nameToTags`, `inferCategory`, `inferPrompt` |
| `skill-install.ts` | `install(source, options)` → installed path + room |
| `skill-assign.ts` | `assignOrphans(mode, options)` → assignment map + `deriveRoomSignals`, `scoreSkillForRooms`, `getOrphanSkills` |
| `config-edit.ts` | `addSkillToRoom(env, skill, room)`, `reloadEnv(env)` (shared smol-toml config mutation) |

All re-exported from `index.ts`; subpath exports added to `package.json`
(`harbor/skills`, `harbor/mcp`, `harbor/skill-create`, `harbor/skill-install`,
`harbor/skill-assign`, `harbor/config-edit`).

CLI subcommands added (citty): `skills-list`, `mcp-check`, `mcp-gen`,
`mcp-merge`, `skill-create`, `skill-install`, `skill-assign`.

Dashboard panels added: `/api/skill-health` (counts by room, orphan set, index
freshness) and `/api/mcp` (per-room server health — no-spawn command/env checks),
each with a frontend panel.

## Spec-silent behaviors resolved from the Python prototype

Per the Behavioral-Fidelity Rule (consult the prototype, write a test, implement):

1. **`getSkillDescription` signature.** The Phase-4 interface requires
   `getSkillDescription(path)`; the prototype's `get_skill_description(env, name)`
   resolved a slug across layouts. Resolved by exposing a pure
   `getSkillDescription(path)` parser (accepts a SKILL.md file *or* its directory)
   and keeping slug→layout resolution inside `getSkill`/`listSkills`. Block
   scalars (`|`/`>`) join indented lines with spaces; output truncates at 100
   chars (97 + "…"), matching the prototype.

2. **Categorized-symlink room assignment (de-perso).** The prototype's "strategy
   2" hardcoded one host-specific external skills root as the symlink-target
   prefix. The TS version recovers the category from whichever
   `skill_pool.sources[].source` the symlink resolves under — works for any
   configured source and names no machine.

3. **Dropped hardcoded room blocks (de-perso).** `generate_room_indexes` emitted
   extra index blocks for two specific rooms even when absent from config. The TS
   version generates indexes for the configured rooms only; the room set is
   entirely config-driven.

4. **Config mutation via smol-toml, not string surgery (interface requirement).**
   The prototype edited config.toml with `str.find`/`str.replace` and special
   cases for empty vs. multi-line skill lists. `config-edit.addSkillToRoom`
   parses → mutates → `stringify`s. Tradeoff: comments / key ordering are not
   preserved; accepted as the cost of structural correctness (the string surgery
   silently corrupted unanticipated layouts). Mutations are idempotent.

5. **Stale-config-after-mutation bug, fixed.** After a config write the in-memory
   `env.config` is stale, so index regeneration would see an empty room.
   `reloadEnv(env)` re-reads config.toml into a fresh Environment before
   indexing. (The prototype reused the same env and could mis-route freshly
   registered skills to the default room.)

6. **Skill-assign signals derived, not hardcoded (de-perso — heaviest lift).** The
   prototype's `ROOM_SIGNALS` baked one machine's room taxonomy + bespoke keyword
   weights into shipped code. `deriveRoomSignals(config)` builds weights at
   runtime from each room's name (×4), assigned skill-name tokens (×4), and
   description words (×2), with a generic stopword list. Preserves the prototype's
   documented intent ("keywords derived from description + skill names") and
   generalizes to any room set.

7. **MCP env extraction.** TOML `env.KEY = "..."` parses to a nested `env` table
   under smol-toml (verified). `extractEnvVars` reads the nested table and, for
   resilience, any flat `env.KEY` keys. `$VAR` and `${VAR}` both reference env
   vars; literals pass through.

8. **MCP connectivity test is opt-in.** `validateServer`/`mcp-check` skip the
   process-start probe by default (it spawns processes); `--connectivity`
   enables it. The dashboard `/api/mcp` panel never spawns — command/env/shape
   checks only.

9. **`skill-install` CLI ergonomics.** Accepts `<source>` (name derived from the
   path basename) *or* `<name> <source>`. The single-positional form matches the
   Phase-4 acceptance invocation `harbor skill-install <path> --room R --dry-run`.
   Positionals are read from `args._` (citty mis-parses multiple declared
   positionals — verified, hence `mcp-merge` rooms and `skill-install` paths both
   read `args._`).

## Test + determinism

- New tests: `skills` (19), `mcp` (24), `skill-create` (9), `skill-install` (9),
  `skill-assign` (9), `config-edit` (7), plus CLI (Phase-4 acceptance cases) and
  dashboard panel tests.
- Full suite: **282 pass / 0 fail**. Typecheck clean (`tsc --noEmit`).
- De-personalization scan over `src/` clean (only the intentional
  `not.toContain("hermes")` / `not.toContain("agent-env")` de-perso regression
  guards remain, which enforce absence).

## Determinism gate remediation (NO-GO #1 → GO)

The first honest 50× measurement was 28/50 green: two Phase-4 tests
(`skill-install.test` index assertion, `cli.test` skill-install positional) failed
in tight clusters during a transient machine-load burst. Root cause was
test-harness fragility under load, not product logic (mutation f/e prove the
guards; ~309 controlled runs after the burst were all green). Fixes — test
isolation and the index-write ordering only; no mutation-verified logic touched:

1. **Subprocess fan-out cut (the load source).** `cli.test.ts` spawned ~36
   `bun cli.ts` subprocesses (a 19-command `--help` loop + functional cases).
   Running alongside the other spawn-heavy suites (`spawn`, `mcp`, `bench`,
   `watch`, `concurrency`) under a burst, that fan-out was the machine-load that
   correlated with the flake. The bulk now runs **in-process** through the same
   citty command tree (`runCommand` for handlers, `renderUsage` for help), with
   **4** true end-to-end subprocess smokes kept (binary+help, a file-writing
   command, the SQLite scheduler, config-loading skill tooling). Spawns: 36 → 4.

2. **Index-write ordering pinned.** `skill-install`'s config-write → reload →
   index-regenerate chain was already fully synchronous; a regression guard
   (`skill-install.test.ts` "index write is synchronous…") now fails if it is ever
   made fire-and-forget — it asserts, with no `await`/tick after `install()`
   returns, that the index file exists *and* contains the routed skill's row, and
   that `install()` returns a non-Promise. A load-bearing comment marks the
   ordering in `skill-install.ts`.

3. **Hermetic isolation from the live machine.** Audit: every Phase-4 and Phase-3
   test already threads an explicit `env`/`workDir`, so none reads the real
   `~/.agent-env` / `~/rooms` / `~/.agents` (confirmed: live state-dir mtimes
   unchanged across runs). Belt-and-suspenders added: a `bunfig.toml` test preload
   (`src/test-setup.ts`) `chdir`s into a throwaway sandbox so the `skill-create`
   `process.cwd()/skills-in-progress` fallback can never scribble into the repo or
   real home, and a tripwire suite (`no-test-reads-the-live-machine.test.ts`) fails
   loudly if the preload is removed or the cwd fallback escapes the sandbox.
   (In-process `os.homedir()` is intentionally not relied on for isolation — Bun
   snapshots it at startup; explicit-env threading is the in-process guarantee.)

4. **Determinism re-proven** (concurrency-sensitive → 100, not 50): **100/100**
   fixed-order + **100/100** `--randomize` + **120/120** lanes under 4× concurrent
   full-suite load = **320/320 green, zero non-green**.

## Gate 4 → 5

Acceptance criteria in `phases/04-tooling.md` all met; determinism gate
re-measured clean. Awaiting independent reviewer sign-off (`REVIEW_04.md`) before
Phase 5.
