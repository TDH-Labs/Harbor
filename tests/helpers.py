"""Shared test helpers for agent_env tests.

Importable from any test file. Fixtures that need pytest dependency go in
conftest.py; pure helper functions live here.
"""
from __future__ import annotations

import copy
import textwrap
from pathlib import Path

from agent_env.config import Config, DEFAULTS, _deep_merge
from agent_env.environment import Environment


# ── Minimal agent_map.md content ──────────────────────────────────────────

MINIMAL_AGENT_MAP = textwrap.dedent("""\
    # Agent Core Map & Routing Protocol

    ## Available Rooms

    | Room | Path | Purpose |
    |------|------|---------|
    | Research | ~/rooms/research/ | Papers, analysis |
    | Writing  | ~/rooms/writing/  | Drafts, editing |

    ## Active Projects

    | Project | Path | Status |
    |---------|------|--------|
    | TestProject | ~/workspace/testproject/ | Active |

    ## Core Directives

    1. Never ingest raw data directly into your primary context window.
    2. Never traverse outside of the environment root unless explicitly asked.

    ## Security

    - Root scope: the environment root — all file operations must resolve within this prefix.
""")


# ── Full agent_map.md with multiple tables ─────────────────────────────────

FULL_AGENT_MAP = textwrap.dedent("""\
    <!-- agent-env schema: 1.0 -->
    # Agent Core Map & Routing Protocol

    > Read this first.

    ## Architectural Overview

    This environment uses a 5-layer structure for agent context.

    ## Available Rooms

    | Room | Path | Purpose |
    |------|------|---------|
    | Research | ~/rooms/research/ | Papers, analysis, market intelligence |
    | Writing  | ~/rooms/writing/  | Drafts, editing, content strategy |
    | DevOps   | ~/rooms/devops/   | CI/CD, infrastructure, automation |

    ## Active Projects

    | Project | Path | Status |
    |---------|------|--------|
    | TestProject | ~/workspace/testproject/ | Active |
    | AnotherProject | ~/workspace/anotherproject/ | Exploratory |

    ## Skill Systems

    All skills live in ~/.agents/skills/ — a shared pool.

    ## Core Directives

    1. Never ingest raw data directly.
    2. Never traverse outside the environment root.
    3. Use compaction workflow.

    ## Security

    - Root scope: the environment root.
""")


# ── Config factory ──────────────────────────────────────────────────────────

def make_config(**overrides):
    """Build a Config from DEFAULTS with optional top-level overrides.

    Dict overrides are deep-merged. For full replacement construct the Config
    manually.
    """
    data = copy.deepcopy(DEFAULTS)
    for key, val in overrides.items():
        if key in data and isinstance(data[key], dict) and isinstance(val, dict):
            data[key] = _deep_merge(data[key], val)
        else:
            data[key] = copy.deepcopy(val)
    return Config(data)


# ── Environment factory ───────────────────────────────────────────────────

def make_env(tmp_path, **config_overrides):
    """Build an Environment rooted at *tmp_path* with a minimal config.

    Creates the standard directory structure (rooms, workspace, data, Obsidian,
    .agent-env, .agents/skills) and writes a minimal agent_map.md.
    """
    config = make_config(**config_overrides)
    env = Environment(tmp_path, config)

    # Standard directories
    for d in [env.workspace, env.rooms, env.data_dir, env.obsidian, env.state_dir,
              env.skills_dir]:
        d.mkdir(parents=True, exist_ok=True)

    # Write a minimal agent_map.md
    env.agent_map.write_text(MINIMAL_AGENT_MAP)

    # Write a minimal home AGENTS.md so symlink targets resolve
    (env.root / "AGENTS.md").write_text("# AGENTS.md test beacon\n")

    return env


# ── Skill helper ───────────────────────────────────────────────────────────

def write_skill(env, skill_name, description="", category=None):
    """Create a minimal skill directory with SKILL.md under the skills pool."""
    skill_dir = env.skills_dir / skill_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    fm = "---\n"
    if description:
        fm += f'description: "{description}"\n'
    fm += "---\n\n"
    fm += f"# {skill_name}\n\nSkill content here.\n"
    (skill_dir / "SKILL.md").write_text(fm)
    return skill_dir


def write_skill_block_scalar(env, skill_name, indicator="|", description_lines=None):
    """Create a SKILL.md whose frontmatter description uses a YAML block scalar.

    ``indicator`` is ``"|"`` (literal) or ``">"`` (folded).  ``description_lines``
    is a list of strings that become the indented body of the block scalar.
    """
    if description_lines is None:
        description_lines = ["A block scalar description."]
    skill_dir = env.skills_dir / skill_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    body = f"---\ndescription: {indicator}\n"
    for line in description_lines:
        body += f"  {line}\n"
    body += f"---\n\n# {skill_name}\n\nSkill content here.\n"
    (skill_dir / "SKILL.md").write_text(body)
    return skill_dir


# ── Obsidian note helper ──────────────────────────────────────────────────

def write_obsidian_note(env, filename, title="", frontmatter="", body="", key_numbers="",
                       connections=None):
    """Create a minimal Obsidian note in the vault."""
    note_dir = (env.obsidian / filename).parent
    note_dir.mkdir(parents=True, exist_ok=True)
    note_path = env.obsidian / filename

    parts = []
    if frontmatter or title or connections:
        parts.append("---")
        fm_lines = []
        if title:
            fm_lines.append(f"title: {title}")
        if frontmatter:
            fm_lines.append(frontmatter)
        if connections:
            conn_str = ", ".join(f"[[{c}]]" for c in connections)
            fm_lines.append(f"connected_to: {conn_str}")
        parts.append("\n".join(fm_lines))
        parts.append("---")
        parts.append("")

    if title:
        parts.append(f"# {title}")
        parts.append("")

    if key_numbers:
        parts.append("## Key Numbers")
        parts.append(key_numbers)
        parts.append("")

    parts.append(body or f"Content of {filename}.")
    parts.append("")
    note_path.write_text("\n".join(parts))
    return note_path