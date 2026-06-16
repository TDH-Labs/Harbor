# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.2.0] — 2026-06-15

### Added

- **Competing-writer detection:** `beacon_sync` now appends a `<!-- agent-env:sync -->`
  provenance stamp to every generated home beacon. `agent-env check` warns when a beacon
  is present but lacks the stamp, signalling that another tool (Hermes, Goose, n8n, a
  custom cron script, etc.) has overwritten it since the last sync.
- **`BEACON_SETUP.md` migration note:** new section "Migrating from a prior beacon setup"
  covering how to disable ALL schedulers (system cron, launchd, Hermes, Goose, n8n, and
  any other automation tool) before switching to agent-env to prevent competing writes.
- **`skills.default_room` config key:** controls which room uncategorised skills fall back
  to when they have no explicit mapping in `skill_category_to_room`. Defaults to `"devops"`,
  fully overridable in `config.toml`.

### Fixed

- **YAML block-scalar skill descriptions:** `get_skill_description` now correctly reads
  `|` (literal) and `>` (folded) block scalar values in SKILL.md frontmatter, collecting
  indented continuation lines. Previously these indicators returned empty or the literal
  `">"` string, causing skills to appear with no description in room indexes.

### Changed

- **Skills wording in generated beacons:**
  - `CLAUDE.md` beacon now says "Read pool is `<skills>/`" and distinguishes reading
    the pool from authoring skills (symlinked from source dirs configured in
    `[skill_pool.sources]`).
  - `AGENTS.md` beacon "Skill Storage" section now uses the configured `skills_dir`
    path (no longer hardcodes `~/.agents/skills`) and removes the stale skill count.
  - `skills_index.md` "Storage" and "How to Use" lines now use the configured path.

---

## [0.1.0] — 2026-06-07

First pre-release. All six core modules are packaged, tested, and wired to the
`agent-env` CLI. The onboarding interview produces a complete, valid environment
in under two minutes.

### Added

**Core modules (Phases 0–1)**
- Package `agent_env` with the 6 original scripts as importable modules
- `agent_env/config.py` — TOML config loading (stdlib tomllib / tomli on 3.10)
- `agent_env/environment.py` — `Environment` object: root + all derived paths
- `agent_env/mdtables.py` — shared markdown table parse/insert

**Watcher (Phase 3)**
- `agent_env/beacon_watcher.py` rewritten: self-daemonizing double-fork daemon,
  fswatch backend with 5s polling fallback, `CooldownGate` pending-flag fix for
  event-dropping, SIGTERM + stale-pidfile handling, PID identity token

**CLI (Phase 4)**
- `agent-env` console entry point (`agent_env/cli.py`)
- Subcommands: `setup`, `init`, `sync`, `watch`, `start`, `stop`,
  `new-project`, `check`, `teardown`, `tidy`, `migrate`
- `setup` records a manifest; `teardown` removes only manifest-listed paths with
  containment checks and user-modified-file prompts
- `check` read-only health report: config, map tables, beacon freshness, version
  stamp, fswatch availability, broken symlinks
- Two-layer teardown path containment (lexical + realpath)

**Onboarding interview (Phase 5a)**
- `agent_env/interview.py` — 6-question industry-driven interview
- Produces `config.toml` + `agent_map.md` that pass `check` immediately
- Non-interactive mode (`--from-answers FILE` / `--defaults`) for automation
- Scan-and-confirm consolidation (MOVE on explicit confirm; rejected → skip list)
- Industry → room constraints from committed `ROOM_CONSTRAINTS` table (never
  invented per-run)

**Demo content (Phase 5b)**
- `agent_env/demo/` — committed generic demo assets: 2 rooms (Research,
  Writing), Obsidian vault with 4 Gbrain Protocol notes, SQLite sample DB,
  workspace compaction files
- `agent-env setup --demo ROOT` materializes demo to ROOT, runs sync + check
- `tests/fixtures/` — generic `agent_map.md` + config for golden rendering

**Docs**
- `CONTRIBUTING.md`, `CHANGELOG.md`, `BEACON_SETUP.md`

### Changed

- All 29 hardcoded home paths replaced with `Environment`-derived
  paths (generic for any user)
- "3-layer" corrected to "5-layer" throughout generated beacon text
- Personal content removed from generators: empty-catalog template, Obsidian
  example paths, stray-file lists moved to config
- `SKIP_DIRS`, `PROJECT_SIGNATURES`, `HOME_WHITELIST`, `ROOM_SKILLS`,
  `skill_category_to_room`, watch paths, beacon targets moved to config
- Destructive hygiene extracted into `agent_env/tidy.py`, config-gated, default
  OFF (decision #7)
- Dead `update_agent_map()` deleted; `mdtables` consolidates three divergent
  markdown-table implementations

### Fixed

- `get_skill_description()` loop bug (Phase 2 finding)
- `clean_stray_files()` missing archive-dir creation (Phase 2 finding)
- Obsidian `_index.md` self-inclusion on idempotency (Phase 2 finding)
- Event-dropping during cooldown: pending-flag fires one coalesced sync when
  cooldown expires (decision #11)
- PID reuse false positive: identity token (start-time + argv) checks on both
  `start()` and `stop()` (Phase 3 finding F-A)
- Teardown path traversal: lexical hard-reject + realpath containment prevents
  `../evil`-style manifest entries from deleting outside root (Phase 4 finding F1)

### Security

- `setup --demo` never writes to real `$HOME`; demo root is always caller-supplied
- `teardown` refuses to remove paths not in manifest or outside root
- Init consolidation MOVE uses `.name` comparison (basenames only); user-supplied
  names can never traverse outside workspace

**Phase 6 (CI, migration, packaging)**
- `agent-env migrate`: detects schema version from stamp comment, backs up map
  to `~/.agent-env/backups/` before any change, transforms v0 (3-layer, no
  stamp) → 1.0, idempotent (second run is always a no-op), `--dry-run` flag
- GitHub Actions CI matrix (ubuntu × macos × Python 3.10–3.13): install,
  ruff lint, pytest with `--cov-fail-under=80`
- GitHub Actions release workflow: builds wheel + sdist, `twine check`, then
  publishes to PyPI via `PYPI_API_TOKEN` secret on version tag push
- Personal-data gate CI job: greps shipping files for absolute user-home
  paths (macOS `/Users/` and Linux `/home/` prefixes); fails build on any
  match; excludes tests/ and internal docs; includes a self-test step so
  the gate cannot silently rot
- `README.md` placed (content from marketing/README.draft.md, internal HTML
  comment stripped, slug and GIF placeholders marked for operator)
- `pyproject.toml` finalized: version 0.1.0, `readme = "README.md"`, proper
  classifiers and project URLs, `ruff` + `build` + `twine` in dev extras
- `agent_env/__init__.py` version aligned to 0.1.0 (was 1.0.0.dev0 — mismatch
  with CHANGELOG fixed)
- `agent_env/migrate.py` module + `tests/test_migrate.py` (34 tests, 99% coverage)
- `tests/fixtures/v0_agent_map.md` — committed generic v0 fixture for migrate tests
- `scripts/fresh_history_cut.sh` — automated clean public-repo creation with
  personal-data gate verification; prints operator push steps, never pushes
- `RELEASE.md` — complete operator release checklist (preflight, fresh-history
  cut, GitHub setup, post-push verification)
- Renamed the skill-category-to-room config key and its companion helper
  throughout source and tests: removes the last internal agent name from
  the public API

---

[Unreleased]: https://github.com/adamrmatar/Harbor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/adamrmatar/Harbor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/adamrmatar/Harbor/releases/tag/v0.1.0
