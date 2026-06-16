# Golden baseline (Phase 5b)

These files are **generated from a committed generic fixture** (see
`tests/fixtures/`), not from any live machine. They contain zero personal data
and are machine-independent.

Path normalization: all occurrences of the tmp root used during rendering are
replaced with `<HOME>`, so the goldens remain stable across machines and
invocations. Timestamps are replaced with `<TS>`.

## How goldens are regenerated

```bash
python3 tests/golden_render.py --update   # regenerate from fixture
python3 tests/golden_render.py            # verify all pass
```

## Fixture source

| Fixture file | Purpose |
|---|---|
| `tests/fixtures/generic_agent_map.md` | 2 generic rooms (Research, Writing), 1 project |
| `tests/fixtures/generic_config.toml` | Minimal config; `<HOME>` is replaced at render time |
| `agent_env/demo/` | Obsidian vault, data catalog, workspace files |

## Golden files

| Golden file | Rendered by |
|---|---|
| `AGENTS.md` | `generate_home_agents_md` against generic fixture |
| `CLAUDE.md` | `generate_home_claude_md` against generic fixture |
| `.cursorrules` | `generate_home_cursorrules` against generic fixture |
| `Obsidian/_index.md` | `sync_obsidian_index.scan_vault` on demo Obsidian notes |
| `data/catalog.md` | `build_data_catalog` on demo data dir |
| `rooms/research/skills_index.md` | `generate_room_index` for research room (empty pool) |
