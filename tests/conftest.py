"""Pytest fixtures for agent_env tests — thin wrappers around helpers.py."""
from __future__ import annotations

import copy

import pytest

from agent_env.config import Config, DEFAULTS
from agent_env.environment import Environment
from tests.helpers import (
    MINIMAL_AGENT_MAP,
    FULL_AGENT_MAP,
    make_config,
    make_env,
    write_skill,
    write_obsidian_note,
)


# Re-export helpers so test files can do `from tests.helpers import ...`
# But pytest fixtures are the preferred way for test parametrization.


@pytest.fixture
def tmp_env(tmp_path):
    """An Environment rooted at tmp_path with standard dirs and minimal agent_map."""
    return make_env(tmp_path)


@pytest.fixture
def full_env(tmp_path):
    """An Environment with a full agent_map (3 rooms, 2 projects) and skills."""
    env = make_env(tmp_path)
    env.agent_map.write_text(FULL_AGENT_MAP)

    # Create room directories
    for room in ["research", "writing", "devops"]:
        (env.rooms / room).mkdir(parents=True, exist_ok=True)

    # Create workspace project directories
    for proj in ["testproject", "anotherproject"]:
        proj_dir = env.workspace / proj
        proj_dir.mkdir(parents=True, exist_ok=True)
        for cf in ["research.md", "plan.md", "scratchpad.md"]:
            (proj_dir / cf).write_text(f"# {cf.replace('.md', '').title()}\n\n")

    # Create skills
    for name, desc in [("research-start", "Start a research project"),
                       ("arxiv", "Search arXiv papers"),
                       ("copywriting", "Write compelling copy")]:
        write_skill(env, name, description=desc)

    # Config with room-skill mappings
    env_config = make_config(
        skills={
            "rooms": {
                "research": {
                    "description": "Papers, analysis, market intelligence",
                    "skills": ["research-start", "arxiv"],
                },
                "writing": {
                    "description": "Drafts, editing, content strategy",
                    "skills": ["copywriting"],
                },
            },
            "skill_category_to_room": {},
        }
    )
    return Environment(tmp_path, env_config)


@pytest.fixture
def config_defaults():
    """The raw DEFAULTS dict (deep-copied) for mutation in tests."""
    return copy.deepcopy(DEFAULTS)