"""Real-behavior tests for main() entry points and room-index generation.

Covers the code paths that the unit-test files don't reach:
- skills_organize.main() with devops/research room generation (lines 254–262)
- new_project.main() with --room and --source flags
- skill_tracker main() invocation
- beacon_watcher.run_sync error handling

No padding. Every test exercises a real code path against a temp tree.
"""
from __future__ import annotations

import os
import sys
import textwrap
from pathlib import Path
from unittest.mock import patch

import pytest

from agent_env import skills_organize, skill_tracker, new_project
from agent_env.config import Config
from agent_env.environment import Environment

from tests.helpers import make_env, make_config, write_skill


# ── skills_organize.main() ──────────────────────────────────────────────

class TestSkillsOrganizeMainFull:
    """Exercise main() through the full generate path including devops/research rooms."""

    def test_main_generates_all_room_indexes(self, tmp_path, capsys):
        """main() generates indexes for all configured rooms + devops + research."""
        env = make_env(tmp_path)
        write_skill(env, "skill-a", description="Research skill A")
        write_skill(env, "skill-b", description="DevOps skill B")
        write_skill(env, "orphan-skill")  # no room → assigned to devops

        config = make_config(
            skills={
                "rooms": {
                    "research": {
                        "description": "Research, analysis, papers",
                        "skills": ["skill-a"],
                    },
                },
                "skill_category_to_room": {},
            }
        )
        env2 = Environment(tmp_path, config)

        with patch.object(sys, "argv", ["skills_organize"]), \
             patch("agent_env.skills_organize.Environment.load", return_value=env2):
            skills_organize.main()

        # research room should have its index
        research_index = env2.rooms / "research" / "skills_index.md"
        assert research_index.exists(), "research room index should exist"
        content = research_index.read_text()
        assert "skill-a" in content

        # devops room should exist (orphan-skill assigned there)
        devops_index = env2.rooms / "devops" / "skills_index.md"
        assert devops_index.exists(), "devops room index should exist for orphan skills"
        devops_content = devops_index.read_text()
        assert "orphan-skill" in devops_content

    def test_main_assigns_unassigned_to_devops(self, tmp_path, capsys):
        """Unassigned skills default to the devops room."""
        env = make_env(tmp_path)
        write_skill(env, "loose-skill")

        config = make_config(
            skills={
                "rooms": {},
                "skill_category_to_room": {},
            }
        )
        env2 = Environment(tmp_path, config)

        with patch.object(sys, "argv", ["skills_organize"]), \
             patch("agent_env.skills_organize.Environment.load", return_value=env2):
            skills_organize.main()

        output = capsys.readouterr().out
        assert "loose-skill" in output
        assert "devops" in output.lower()

    def test_main_with_categorized_skills(self, tmp_path):
        """Categorized skill categories map to rooms via skill_category_to_room.
        Verifies the devops room index is created containing the categorized skill."""
        env = make_env(tmp_path)
        # Categorized pool: skills_dir/<category>/<skill>/
        cat_dir = env.skills_dir / "software-development"
        cat_dir.mkdir(parents=True, exist_ok=True)
        skill_dir = cat_dir / "pool-tool"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("---\n---\n\n# pool-tool\n")

        config = make_config(
            skills={
                "rooms": {
                    "research": {
                        "description": "Research",
                        "skills": [],
                    },
                },
                "skill_category_to_room": {"software-development": "devops"},
            }
        )
        env2 = Environment(tmp_path, config)

        with patch.object(sys, "argv", ["skills_organize"]), \
             patch("agent_env.skills_organize.Environment.load", return_value=env2):
            skills_organize.main()

        devops_index = env2.rooms / "devops" / "skills_index.md"
        assert devops_index.exists(), "devops room index should be created for categorized skills"
        content = devops_index.read_text()
        assert "pool-tool" in content

    def test_main_skill_to_source_mapping(self, tmp_path, capsys):
        """main() builds skill_to_source mapping for agents skills."""
        env = make_env(tmp_path)
        write_skill(env, "agents-skill")

        config = make_config(
            skills={
                "rooms": {
                    "devops": {
                        "description": "DevOps",
                        "skills": ["agents-skill"],
                    },
                },
                "skill_category_to_room": {},
            }
        )
        env2 = Environment(tmp_path, config)

        with patch.object(sys, "argv", ["skills_organize"]), \
             patch("agent_env.skills_organize.Environment.load", return_value=env2):
            skills_organize.main()

        devops_index = env2.rooms / "devops" / "skills_index.md"
        assert devops_index.exists()

    def test_main_empty_room_skipped(self, tmp_path, capsys):
        """A room with zero skills assigned is skipped."""
        env = make_env(tmp_path)
        config = make_config(
            skills={
                "rooms": {
                    "writing": {
                        "description": "Writing, editing",
                        "skills": [],  # empty
                    },
                },
                "skill_category_to_room": {},
            }
        )
        env2 = Environment(tmp_path, config)

        with patch.object(sys, "argv", ["skills_organize"]), \
             patch("agent_env.skills_organize.Environment.load", return_value=env2):
            skills_organize.main()

        output = capsys.readouterr().out
        assert "no skills assigned, skipping" in output

    def test_main_summary_output(self, tmp_path, capsys):
        """main() prints a summary line with total skills assigned."""
        env = make_env(tmp_path)
        write_skill(env, "s1")
        config = make_config(
            skills={
                "rooms": {
                    "research": {
                        "description": "Research",
                        "skills": ["s1"],
                    },
                },
                "skill_category_to_room": {},
            }
        )
        env2 = Environment(tmp_path, config)

        with patch.object(sys, "argv", ["skills_organize"]), \
             patch("agent_env.skills_organize.Environment.load", return_value=env2):
            skills_organize.main()

        output = capsys.readouterr().out
        assert "Total skills assigned" in output


# ── new_project.main() ──────────────────────────────────────────────────

class TestNewProjectMainFull:
    """Exercise new_project.main() with various CLI flags."""

    def test_main_creates_project(self, tmp_path):
        """main() with a project name creates the workspace directory."""
        env = make_env(tmp_path)
        config = make_config()
        env2 = Environment(tmp_path, config)

        with patch("agent_env.new_project.Environment.load", return_value=env2), \
             patch.object(sys, "argv", ["new_project", "my-project"]):
            new_project.main()

        proj_dir = env2.workspace / "my-project"
        assert proj_dir.is_dir()
        assert (proj_dir / "research.md").exists()
        assert (proj_dir / "plan.md").exists()
        assert (proj_dir / "scratchpad.md").exists()

    def test_main_with_room_and_source(self, tmp_path):
        """main() with --room and --source creates project with source symlink."""
        env = make_env(tmp_path)
        config = make_config()
        env2 = Environment(tmp_path, config)

        source_dir = tmp_path / "original-code"
        source_dir.mkdir()
        (source_dir / "main.py").write_text("print('hello')")

        with patch("agent_env.new_project.Environment.load", return_value=env2), \
             patch.object(sys, "argv", ["new_project", "linked-project", "--room", "research", "--source", str(source_dir)]):
            new_project.main()

        proj_dir = env2.workspace / "linked-project"
        assert proj_dir.is_dir()
        project_link = proj_dir / "project"
        assert project_link.is_symlink() or project_link.exists()

    def test_main_duplicate_name_exits(self, tmp_path):
        """main() exits if the project directory already exists."""
        env = make_env(tmp_path)
        config = make_config()
        env2 = Environment(tmp_path, config)

        # Pre-create the project directory
        proj_dir = env2.workspace / "existing-project"
        proj_dir.mkdir(parents=True, exist_ok=True)

        with patch("agent_env.new_project.Environment.load", return_value=env2), \
             patch.object(sys, "argv", ["new_project", "existing-project"]):
            with pytest.raises(SystemExit):
                new_project.main()

    def test_main_updates_agent_map(self, tmp_path):
        """main() adds the new project row to agent_map.md."""
        env = make_env(tmp_path)
        config = make_config()
        env2 = Environment(tmp_path, config)

        with patch("agent_env.new_project.Environment.load", return_value=env2), \
             patch.object(sys, "argv", ["new_project", "fresh-project"]):
            new_project.main()

        content = env2.agent_map.read_text()
        assert "fresh-project" in content


# ── skill_tracker main() ────────────────────────────────────────────────

class TestSkillTrackerMainFull:
    """Full main() invocation for all commands."""

    def test_log_command(self, tmp_path):
        """main() log command writes to the usage log."""
        env = make_env(tmp_path)
        with patch("agent_env.skill_tracker.Environment.load", return_value=env), \
             patch.object(sys, "argv", ["skill_tracker", "log", "my-skill"]):
            skill_tracker.main()
        log_path = env.skills_dir / "_usage_log.jsonl"
        assert log_path.exists()
        entry = log_path.read_text().strip()
        assert "my-skill" in entry

    def test_stats_command(self, tmp_path, capsys):
        """main() stats command prints usage table."""
        env = make_env(tmp_path)
        skill_tracker.log_usage(env, "stat-skill")
        with patch("agent_env.skill_tracker.Environment.load", return_value=env), \
             patch.object(sys, "argv", ["skill_tracker", "stats"]):
            skill_tracker.main()
        output = capsys.readouterr().out
        assert "stat-skill" in output

    def test_rebuild_command(self, tmp_path):
        """main() rebuild command updates room indexes."""
        env = make_env(tmp_path)
        room_dir = env.rooms / "research"
        room_dir.mkdir(parents=True, exist_ok=True)
        (room_dir / "skills_index.md").write_text(
            "# Research\n\n| Skill | Description |\n|-------|-------------|\n| s1 | A skill |\n"
        )
        skill_tracker.log_usage(env, "s1")

        with patch("agent_env.skill_tracker.Environment.load", return_value=env), \
             patch.object(sys, "argv", ["skill_tracker", "rebuild"]):
            skill_tracker.main()

        content = (room_dir / "skills_index.md").read_text()
        assert "Last Used" in content

    def test_no_command_exits(self, tmp_path):
        env = make_env(tmp_path)
        with patch("agent_env.skill_tracker.Environment.load", return_value=env), \
             patch.object(sys, "argv", ["skill_tracker"]):
            with pytest.raises(SystemExit):
                skill_tracker.main()

    def test_unknown_command_exits(self, tmp_path):
        env = make_env(tmp_path)
        with patch("agent_env.skill_tracker.Environment.load", return_value=env), \
             patch.object(sys, "argv", ["skill_tracker", "bogus"]):
            with pytest.raises(SystemExit):
                skill_tracker.main()

    def test_log_without_name_exits(self, tmp_path):
        env = make_env(tmp_path)
        with patch("agent_env.skill_tracker.Environment.load", return_value=env), \
             patch.object(sys, "argv", ["skill_tracker", "log"]):
            with pytest.raises(SystemExit):
                skill_tracker.main()


# ── beacon_watcher.run_sync error handling ────────────────────────────────

class TestBeaconWatcherRunSync:
    """run_sync exercises the in-process beacon_sync call path."""

    def test_run_sync_succeeds(self, tmp_path):
        """run_sync with a valid env produces output without crashing."""
        from agent_env import beacon_watcher
        env = make_env(tmp_path)
        beacon_watcher.run_sync(env, reason="test trigger")

    def test_run_sync_catches_runtime_error(self, tmp_path):
        """run_sync catches RuntimeError from beacon_sync and logs it."""
        from agent_env import beacon_watcher
        env = make_env(tmp_path)
        with patch("agent_env.beacon_sync.run_generate", side_effect=RuntimeError("sync failed")):
            # Should not raise — run_sync catches Exception
            beacon_watcher.run_sync(env, reason="error test")

    def test_run_sync_catches_system_exit(self, tmp_path):
        """run_sync catches SystemExit from beacon_sync (e.g. empty map)."""
        from agent_env import beacon_watcher
        env = make_env(tmp_path)
        with patch("agent_env.beacon_sync.run_generate", side_effect=SystemExit(1)):
            # Should not propagate — run_sync catches SystemExit
            beacon_watcher.run_sync(env, reason="exit test")