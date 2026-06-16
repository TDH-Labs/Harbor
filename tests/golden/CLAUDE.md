# CLAUDE.md — Machine Orientation

> **Read `<HOME>/agent_map.md` first.** It contains the full routing table, room index, and security boundaries for this machine.

## Quick Start

1. `cat <HOME>/agent_map.md` — read the map
2. Identify which room your task belongs to
3. `cat <HOME>/rooms/<domain>/room_rules.md` — read domain rules
4. `cd <HOME>/workspace/<project>/` — work in the workspace

## Key Conventions

- **Workspace-first:** All active work happens in `~/workspace/<project>/`, not `~/Downloads/` or `~/Desktop/`
- **Compaction workflow:** Research → `research.md` → Plan → `plan.md` → Execute from plan only
- **Large outputs:** Dump to `scratchpad.md`, read iteratively (never flood context)
- **Secrets:** `~/secrets/` only, 600 permissions, never committed
- **Skills:** Read pool is `<HOME>/.agents/skills/` — agents load skills from here. Skills are authored in source dirs and symlinked in (see `config.toml [skill_pool.sources]`).
- **Room rules are mandatory** — each domain has constraints in its `room_rules.md`

## References

- `<HOME>/AGENTS.md` — Full orientation (cross-tool beacon)
- `<HOME>/agent_map.md` — Master routing and project table
- `<HOME>/rooms/*/room_rules.md` — Domain-specific rules
- `<HOME>/rooms/*/skills_index.md` — Available skills per domain
- `<HOME>/workspace/MAPPING.md` — Symlink mapping between workspace dirs and originals

<!-- agent-env:sync -->
