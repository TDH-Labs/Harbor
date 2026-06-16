#!/usr/bin/env python3
"""
golden_render.py — Golden-file verification harness.

Materializes demo content to a temp directory, renders beacon/index outputs
in memory from the committed generic fixture, and diffs them against the
committed goldens in tests/golden/.

The generic fixture (tests/fixtures/generic_agent_map.md + generic_config.toml)
contains ZERO personal data. The rendered output is path-normalized before
comparison: the actual tmp dir path is replaced with the placeholder ``<HOME>``
in both rendered output and golden files, so goldens are machine-independent.

Uses ``agent_env/demo/`` as the source of generic content (Obsidian vault, data
layer, workspace files).  Never reads ~/agent_map.md or config.local.toml.

Usage::

    python3 tests/golden_render.py              # diff all renders vs goldens
    python3 tests/golden_render.py -v            # also print full diffs
    python3 tests/golden_render.py --update      # write normalized goldens
    python3 tests/golden_render.py AGENTS.md     # check one file

Exit code 0 = every render matches its golden (path+timestamp-normalized);
non-zero = at least one unexpected diff.
"""
from __future__ import annotations

import difflib
import re
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GOLDEN = REPO / "tests" / "golden"
FIXTURES = REPO / "tests" / "fixtures"

# Ensure the in-repo package is importable when run as a script.
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

# ── Normalization ─────────────────────────────────────────────────────────────

_TS = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}")
_HOME_PLACEHOLDER = "<HOME>"


def _norm(text: str, root: str) -> str:
    """Normalize volatile content before comparing rendered vs. golden.

    Replaces the actual tmp root path with ``<HOME>`` and auto-generated
    timestamps with ``<TS>`` so goldens are machine- and time-independent.
    """
    text = text.replace(root, _HOME_PLACEHOLDER)
    return _TS.sub("<TS>", text)


# ── Fixture environment ───────────────────────────────────────────────────────

def _build_fixture_env(tmp_root: Path):
    """Materialize demo content to *tmp_root*, overlay the generic agent_map.md,
    write a real config.toml, and return an (env, root_str) tuple."""
    import tomllib

    from agent_env.demo import materialize
    from agent_env.config import Config
    from agent_env.environment import Environment

    # Materialize generic demo content (Obsidian, data, workspace, rooms).
    materialize(tmp_root)

    root_str = str(tmp_root)

    # Replace the demo agent_map.md with the committed generic fixture.
    fixture_map = (FIXTURES / "generic_agent_map.md").read_text()
    (tmp_root / "agent_map.md").write_text(
        fixture_map.replace(_HOME_PLACEHOLDER, root_str)
    )

    # Write a real config.toml (fixture template has <HOME> as placeholder).
    fixture_cfg_text = (FIXTURES / "generic_config.toml").read_text()
    cfg_text = fixture_cfg_text.replace(_HOME_PLACEHOLDER, root_str)
    state_dir = tmp_root / ".agent-env"
    state_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = state_dir / "config.toml"
    cfg_path.write_text(cfg_text)

    cfg = Config.load(str(cfg_path))
    env = Environment(tmp_root, cfg, config_path=str(cfg_path))
    return env, root_str


# ── Renderers ─────────────────────────────────────────────────────────────────

def _env_and_root(tmp_root: Path):
    """Lazy accessor so each renderer call reuses the same env."""
    return _build_fixture_env(tmp_root)


def render_home_agents(env, root_str: str) -> str:
    from agent_env import beacon_sync as bs
    content = bs.read_file(env.agent_map)
    rooms = bs.parse_rooms_from_map(content)
    projects = bs.parse_projects_from_map(content)
    return bs.generate_home_agents_md(env, content, rooms, projects)


def render_home_claude(env, root_str: str) -> str:
    from agent_env import beacon_sync as bs
    return bs.generate_home_claude_md(env)


def render_home_cursorrules(env, root_str: str) -> str:
    from agent_env import beacon_sync as bs
    content = bs.read_file(env.agent_map)
    rooms = bs.parse_rooms_from_map(content)
    return bs.generate_home_cursorrules(env, rooms)


def render_obsidian_index(env, root_str: str) -> str:
    from agent_env import sync_obsidian_index as soi
    entries = soi.scan_vault(env)
    return soi.build_index(entries)


def render_data_catalog(env, root_str: str) -> str:
    from agent_env import beacon_sync as bs
    content, _ = bs.build_data_catalog(env)
    return content


def render_research_skills_index(env, root_str: str) -> str:
    """Render a skills index for the 'research' room (generic fixture).

    The generic fixture has no skill pool, so this renders the empty-room
    template (which still exercises the generate_room_index code path).
    """
    from agent_env import skills_organize as so
    room_data = {
        "description": "Literature review, data gathering, synthesis",
        "skills": [],
    }
    return so.generate_room_index(env, "research", room_data, [], {})


# golden relative path → renderer function (env, root_str) → str
RENDERERS: dict[str, object] = {
    "AGENTS.md":                       render_home_agents,
    "CLAUDE.md":                       render_home_claude,
    ".cursorrules":                    render_home_cursorrules,
    "Obsidian/_index.md":              render_obsidian_index,
    "data/catalog.md":                 render_data_catalog,
    "rooms/research/skills_index.md":  render_research_skills_index,
}


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    verbose = "-v" in sys.argv
    update  = "--update" in sys.argv
    only    = [a for a in sys.argv[1:] if not a.startswith("-")]

    with tempfile.TemporaryDirectory(prefix="agent-env-golden-") as tmp:
        tmp_root = Path(tmp)
        env, root_str = _build_fixture_env(tmp_root)

        failures = 0
        for rel, renderer in RENDERERS.items():
            if only and rel not in only:
                continue
            golden_path = GOLDEN / rel

            if update:
                try:
                    rendered = renderer(env, root_str)
                except Exception as e:
                    print(f"ERROR {rel}  (renderer raised {type(e).__name__}: {e})")
                    failures += 1
                    continue
                normalized = _norm(rendered, root_str)
                golden_path.parent.mkdir(parents=True, exist_ok=True)
                golden_path.write_text(normalized)
                print(f"WROTE {rel}")
                continue

            golden_text = (
                golden_path.read_text() if golden_path.exists()
                else "<MISSING GOLDEN>"
            )
            try:
                rendered = renderer(env, root_str)
            except Exception as e:
                print(f"DIFF  {rel}  (renderer raised {type(e).__name__}: {e})")
                failures += 1
                continue

            norm_rendered = _norm(rendered, root_str)
            # Goldens are already stored normalized (no real paths, no timestamps).
            norm_golden   = _TS.sub("<TS>", golden_text)

            if norm_rendered == norm_golden:
                print(f"PASS  {rel}")
            else:
                failures += 1
                print(f"DIFF  {rel}")
                if verbose:
                    diff = difflib.unified_diff(
                        norm_golden.splitlines(keepends=True),
                        norm_rendered.splitlines(keepends=True),
                        fromfile=f"golden/{rel}",
                        tofile=f"rendered/{rel}",
                    )
                    sys.stdout.writelines(diff)
                    print()

    verb = "updated" if update else "checked"
    n = len(RENDERERS) if not only else len(only)
    suffix = "" if update else f", {failures} diffs"
    print(f"\n{'OK' if failures == 0 else 'FAIL'}: {n} {verb}{suffix}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
