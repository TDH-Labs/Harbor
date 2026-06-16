"""Tests for agent_env/new_project.py — project scaffolding, slug generation, agent_map update."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from agent_env import new_project
from agent_env.config import Config, DEFAULTS
from agent_env.environment import Environment

from tests.helpers import make_env, MINIMAL_AGENT_MAP


class TestSlugify:
    """slugify converts project names to directory-safe slugs."""

    def test_basic_name(self):
        assert new_project.slugify("My Project") == "my-project"

    def test_special_characters(self):
        assert new_project.slugify("Hello! world?") == "hello-world"

    def test_leading_trailing_spaces(self):
        assert new_project.slugify("  spaces  ") == "spaces"

    def test_multiple_hyphens(self):
        result = new_project.slugify("a---b")
        assert "---" not in result

    def test_uppercase(self):
        assert new_project.slugify("UPPERCASE") == "uppercase"

    def test_mixed_case(self):
        assert new_project.slugify("MixedCase") == "mixedcase"


class TestCreateWorkspace:
    """create_workspace builds a project directory with compaction files."""

    def test_creates_directory(self, tmp_path):
        env = make_env(tmp_path)
        new_project.create_workspace(env, "test-project")
        assert (env.workspace / "test-project").is_dir()

    def test_creates_compaction_files(self, tmp_path):
        env = make_env(tmp_path)
        new_project.create_workspace(env, "test-project")
        proj_dir = env.workspace / "test-project"
        assert (proj_dir / "research.md").exists()
        assert (proj_dir / "plan.md").exists()
        assert (proj_dir / "scratchpad.md").exists()

    def test_compaction_file_content(self, tmp_path):
        env = make_env(tmp_path)
        new_project.create_workspace(env, "test-project")
        content = (env.workspace / "test-project" / "plan.md").read_text()
        assert "test-project" in content.lower() or "Plan" in content

    def test_creates_agents_md_symlink(self, tmp_path):
        env = make_env(tmp_path)
        new_project.create_workspace(env, "test-project")
        beacon = env.workspace / "test-project" / "AGENTS.md"
        assert beacon.is_symlink() or beacon.exists()

    def test_with_source_symlink(self, tmp_path):
        env = make_env(tmp_path)
        # Create a source directory
        source = tmp_path / "original-project"
        source.mkdir()
        new_project.create_workspace(env, "linked-project", source=str(source))
        proj_dir = env.workspace / "linked-project"
        assert (proj_dir / "project").is_symlink()

    def test_rejects_duplicate_name(self, tmp_path):
        env = make_env(tmp_path)
        new_project.create_workspace(env, "unique-project")
        with pytest.raises(SystemExit):
            new_project.create_workspace(env, "unique-project")


class TestUpdateAgentMap:
    """update_agent_map adds a new project row to agent_map.md."""

    def test_adds_row(self, tmp_path):
        env = make_env(tmp_path)
        new_project.update_agent_map(env, "test-project", "Test Project", None, None)
        content = env.agent_map.read_text()
        assert "test-project" in content
        assert "Test Project" in content

    def test_adds_row_with_room(self, tmp_path):
        env = make_env(tmp_path)
        new_project.update_agent_map(env, "research-project", "Research Project", "research", None)
        content = env.agent_map.read_text()
        assert "research-project" in content

    def test_preserves_existing_content(self, tmp_path):
        env = make_env(tmp_path)
        original_content = env.agent_map.read_text()
        new_project.update_agent_map(env, "new-project", "New Project", None, None)
        updated_content = env.agent_map.read_text()
        # Original content (rooms, directives) should still be there
        assert "Research" in updated_content
        assert "new-project" in updated_content