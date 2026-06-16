"""Tests for agent_env/beacon_sync.py — beacon generation, discovery, symlinks."""
from __future__ import annotations

import os
import textwrap
from pathlib import Path

import pytest

from agent_env import beacon_sync
from agent_env.config import Config, DEFAULTS
from agent_env.environment import Environment

from tests.helpers import make_env, make_config, FULL_AGENT_MAP, write_skill


class TestReadFile:
    """read_file reads an existing file or returns empty string."""

    def test_reads_existing_file(self, tmp_path):
        f = tmp_path / "test.txt"
        f.write_text("hello")
        assert beacon_sync.read_file(f) == "hello"

    def test_returns_empty_for_missing(self, tmp_path):
        f = tmp_path / "missing.txt"
        assert beacon_sync.read_file(f) == ""


class TestWriteBeacon:
    """write_beacon creates files and symlinks."""

    def test_force_write_creates_file(self, tmp_path):
        env = make_env(tmp_path)
        target = tmp_path / "AGENTS.md"
        beacon_sync.write_beacon(env, target, "# Beacon\n", force_write=True)
        assert target.exists()
        assert target.read_text() == "# Beacon\n"

    def test_force_write_creates_parent_dirs(self, tmp_path):
        env = make_env(tmp_path)
        target = tmp_path / "deep" / "nested" / "AGENTS.md"
        beacon_sync.write_beacon(env, target, "# Deep\n", force_write=True)
        assert target.exists()

    def test_symlink_creates_link(self, tmp_path):
        env = make_env(tmp_path)
        project_dir = env.workspace / "myproject"
        project_dir.mkdir(parents=True, exist_ok=True)
        target = project_dir / "AGENTS.md"
        beacon_sync.write_beacon(env, target, None)
        assert target.is_symlink()
        assert os.readlink(str(target)) == str(env.root / "AGENTS.md")

    def test_symlink_updates_wrong_target(self, tmp_path):
        env = make_env(tmp_path)
        project_dir = env.workspace / "myproject"
        project_dir.mkdir(parents=True, exist_ok=True)
        target = project_dir / "AGENTS.md"
        # Create symlink to wrong target
        os.symlink("/wrong/path", str(target))
        beacon_sync.write_beacon(env, target, None)
        assert target.is_symlink()
        assert os.readlink(str(target)) == str(env.root / "AGENTS.md")

    def test_symlink_replaces_regular_file(self, tmp_path):
        env = make_env(tmp_path)
        project_dir = env.workspace / "myproject"
        project_dir.mkdir(parents=True, exist_ok=True)
        target = project_dir / "AGENTS.md"
        target.write_text("old content")
        beacon_sync.write_beacon(env, target, None)
        assert target.is_symlink()


class TestDiscovery:
    """Project discovery against temp directories."""

    def test_discover_workspace_projects(self, tmp_path):
        env = make_env(tmp_path)
        (env.workspace / "proj-a").mkdir(parents=True, exist_ok=True)
        (env.workspace / "proj-b").mkdir(parents=True, exist_ok=True)
        found = beacon_sync.discover_workspace_projects(env)
        names = [p.name for p in found]
        assert "proj-a" in names
        assert "proj-b" in names

    def test_discover_home_projects(self, tmp_path):
        env = make_env(tmp_path)
        proj = tmp_path / "my-project"
        proj.mkdir()
        (proj / ".git").mkdir()
        found = beacon_sync.discover_home_projects(env)
        names = [p.name for p in found]
        assert "my-project" in names

    def test_is_project_dir_with_git(self, tmp_path):
        env = make_env(tmp_path)
        proj = tmp_path / "myproj"
        proj.mkdir()
        (proj / ".git").mkdir()
        assert beacon_sync.is_project_dir(env, proj)

    def test_is_project_dir_with_agents_md(self, tmp_path):
        env = make_env(tmp_path)
        proj = tmp_path / "myproj"
        proj.mkdir()
        (proj / "AGENTS.md").write_text("# Beacon\n")
        assert beacon_sync.is_project_dir(env, proj)

    def test_is_project_dir_with_pyproject(self, tmp_path):
        env = make_env(tmp_path)
        proj = tmp_path / "myproj"
        proj.mkdir()
        (proj / "pyproject.toml").write_text("[project]\nname='test'\n")
        assert beacon_sync.is_project_dir(env, proj)

    def test_skips_hidden_dirs(self, tmp_path):
        env = make_env(tmp_path)
        hidden = tmp_path / ".hidden"
        hidden.mkdir()
        (hidden / ".git").mkdir()
        assert not beacon_sync.is_project_dir(env, hidden)

    def test_skips_skip_dirs(self, tmp_path):
        env = make_env(tmp_path)
        scripts = tmp_path / "scripts"
        scripts.mkdir()
        (scripts / ".git").mkdir()
        assert not beacon_sync.is_project_dir(env, scripts)

    def test_discover_all_deduplicates(self, tmp_path):
        env = make_env(tmp_path)
        (env.workspace / "myproj").mkdir(parents=True, exist_ok=True)
        all_projects = beacon_sync.discover_all(env)
        # Should not double-count workspace projects that also appear at home
        names = [p.name for p in all_projects]
        assert names.count("myproj") == 1


class TestParseAgentMap:
    """parse_agent_map splits content into sections."""

    def test_basic_sectioning(self):
        content = textwrap.dedent("""\
            # Title
            intro text
            ## Section One
            line 1
            line 2
            ## Section Two
            line 3
        """)
        sections = beacon_sync.parse_agent_map(content)
        assert "preamble" in sections
        assert "Section One" in sections
        assert "Section Two" in sections

    def test_empty_content(self):
        sections = beacon_sync.parse_agent_map("")
        assert "preamble" in sections


class TestParseRoomsAndProjects:
    """parse_rooms_from_map and parse_projects_from_map extract tables."""

    def test_parse_rooms(self, tmp_path):
        env = make_env(tmp_path)
        env.agent_map.write_text(FULL_AGENT_MAP)
        content = env.agent_map.read_text()
        rooms = beacon_sync.parse_rooms_from_map(content)
        assert len(rooms) == 3
        room_names = [r.get("Room", "") for r in rooms]
        assert "Research" in room_names
        assert "Writing" in room_names
        assert "DevOps" in room_names

    def test_parse_projects(self, tmp_path):
        env = make_env(tmp_path)
        env.agent_map.write_text(FULL_AGENT_MAP)
        content = env.agent_map.read_text()
        projects = beacon_sync.parse_projects_from_map(content)
        assert len(projects) >= 2

    def test_parse_rooms_from_minimal_map(self, tmp_path):
        env = make_env(tmp_path)
        content = env.agent_map.read_text()
        rooms = beacon_sync.parse_rooms_from_map(content)
        assert len(rooms) == 2  # Research and Writing


class TestGenerateHomeAgentsMd:
    """generate_home_agents_md produces the main beacon."""

    def test_says_5_layer(self, tmp_path):
        env = make_env(tmp_path)
        content = env.agent_map.read_text()
        rooms = beacon_sync.parse_rooms_from_map(content)
        projects = beacon_sync.parse_projects_from_map(content)
        result = beacon_sync.generate_home_agents_md(env, content, rooms, projects)
        assert "5-layer" in result
        assert "3-layer" not in result

    def test_no_hardcoded_paths(self, tmp_path):
        env = make_env(tmp_path)
        content = env.agent_map.read_text()
        rooms = beacon_sync.parse_rooms_from_map(content)
        projects = beacon_sync.parse_projects_from_map(content)
        result = beacon_sync.generate_home_agents_md(env, content, rooms, projects)
        assert "/Users/ai/" not in result, "should not contain hardcoded /Users/ai/"

    def test_contains_root_path(self, tmp_path):
        env = make_env(tmp_path)
        content = env.agent_map.read_text()
        rooms = beacon_sync.parse_rooms_from_map(content)
        projects = beacon_sync.parse_projects_from_map(content)
        result = beacon_sync.generate_home_agents_md(env, content, rooms, projects)
        assert str(env.root) in result


class TestGenerateHomeClaudeMd:
    """generate_home_claude_md produces the Claude-specific beacon."""

    def test_references_agent_map(self, tmp_path):
        env = make_env(tmp_path)
        result = beacon_sync.generate_home_claude_md(env)
        assert "agent_map.md" in result

    def test_no_hardcoded_paths(self, tmp_path):
        env = make_env(tmp_path)
        result = beacon_sync.generate_home_claude_md(env)
        assert "/Users/ai/" not in result


class TestGenerateHomeCursorrules:
    """generate_home_cursorrules produces the Cursor beacon."""

    def test_references_root(self, tmp_path):
        env = make_env(tmp_path)
        env.agent_map.write_text(FULL_AGENT_MAP)
        content = env.agent_map.read_text()
        rooms = beacon_sync.parse_rooms_from_map(content)
        result = beacon_sync.generate_home_cursorrules(env, rooms)
        assert str(env.root) in result

    def test_lists_room_slugs(self, tmp_path):
        env = make_env(tmp_path)
        env.agent_map.write_text(FULL_AGENT_MAP)
        content = env.agent_map.read_text()
        rooms = beacon_sync.parse_rooms_from_map(content)
        result = beacon_sync.generate_home_cursorrules(env, rooms)
        assert "research" in result.lower()
        assert "writing" in result.lower()


class TestGenerateProjectAgentsMd:
    """generate_project_agents_md produces per-project beacons."""

    def test_contains_project_name(self, tmp_path):
        env = make_env(tmp_path)
        result = beacon_sync.generate_project_agents_md(env, "my-project")
        assert "my-project" in result

    def test_references_root(self, tmp_path):
        env = make_env(tmp_path)
        result = beacon_sync.generate_project_agents_md(env, "test")
        assert str(env.root) in result

    def test_says_5_layer(self, tmp_path):
        env = make_env(tmp_path)
        result = beacon_sync.generate_project_agents_md(env, "test")
        assert "5-layer" in result


class TestExtractPathSlug:
    """extract_path_slug normalizes project paths."""

    def test_workspace_path(self):
        assert beacon_sync.extract_path_slug("~/workspace/my-project/") == "my-project"

    def test_non_workspace_path(self):
        assert beacon_sync.extract_path_slug("~/my-project/") == "my-project"

    def test_with_backticks(self):
        assert beacon_sync.extract_path_slug("`~/workspace/my-project/`") == "my-project"

    def test_nested_path(self):
        assert beacon_sync.extract_path_slug("~/workspace/deep/nested/") == "nested"

    def test_no_trailing_slash(self):
        assert beacon_sync.extract_path_slug("~/workspace/myproject") == "myproject"

    def test_just_tilde(self):
        assert beacon_sync.extract_path_slug("~") == "~"


class TestEnsureWorkspaceDir:
    """ensure_workspace_dir creates compaction files and beacon symlink."""

    def test_creates_compaction_files(self, tmp_path):
        env = make_env(tmp_path)
        proj = env.workspace / "newproj"
        proj.mkdir(parents=True, exist_ok=True)
        created = beacon_sync.ensure_workspace_dir(env, proj)
        filenames = [p.name for p in created]
        assert "research.md" in filenames
        assert "plan.md" in filenames
        assert "scratchpad.md" in filenames

    def test_creates_beacon_symlink(self, tmp_path):
        env = make_env(tmp_path)
        proj = env.workspace / "newproj"
        proj.mkdir(parents=True, exist_ok=True)
        beacon_sync.ensure_workspace_dir(env, proj)
        beacon = proj / env.config.project_beacon
        assert beacon.is_symlink() or beacon.exists()

    def test_idempotent(self, tmp_path):
        env = make_env(tmp_path)
        proj = env.workspace / "newproj"
        proj.mkdir(parents=True, exist_ok=True)
        beacon_sync.ensure_workspace_dir(env, proj)
        # Second run should not fail
        beacon_sync.ensure_workspace_dir(env, proj)


class TestCheckSymlink:
    """check_symlink reports project symlink state."""

    def test_with_symlink(self, tmp_path):
        env = make_env(tmp_path)
        proj = env.workspace / "myproj"
        proj.mkdir(parents=True, exist_ok=True)
        target = tmp_path / "original"
        target.mkdir()
        (proj / "project").symlink_to(str(target))
        result = beacon_sync.check_symlink(env, proj)
        assert result is not None

    def test_without_symlink(self, tmp_path):
        env = make_env(tmp_path)
        proj = env.workspace / "myproj"
        proj.mkdir(parents=True, exist_ok=True)
        result = beacon_sync.check_symlink(env, proj)
        assert result is None


class TestBuildDataCatalog:
    """build_data_catalog builds a markdown catalog from SQLite databases."""

    def test_empty_catalog(self, tmp_path):
        env = make_env(tmp_path)
        content, count = beacon_sync.build_data_catalog(env)
        assert count == 0
        assert "Example A" in content  # placeholder

    def test_with_database(self, tmp_path):
        import sqlite3
        env = make_env(tmp_path)
        db_dir = env.data_dir / "testdomain"
        db_dir.mkdir(parents=True, exist_ok=True)
        db_path = db_dir / "testdomain.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO records (name) VALUES ('test')")
        conn.commit()
        conn.close()

        content, count = beacon_sync.build_data_catalog(env)
        assert count == 1
        assert "testdomain" in content

    def test_with_multiple_databases(self, tmp_path):
        import sqlite3
        env = make_env(tmp_path)
        for domain in ["alpha", "beta"]:
            db_dir = env.data_dir / domain
            db_dir.mkdir(parents=True, exist_ok=True)
            db_path = db_dir / f"{domain}.db"
            conn = sqlite3.connect(str(db_path))
            conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY)")
            conn.execute("INSERT INTO items VALUES (1)")
            conn.commit()
            conn.close()

        content, count = beacon_sync.build_data_catalog(env)
        assert count == 2
        assert "alpha" in content
        assert "beta" in content


class TestSyncDataCatalog:
    """sync_data_catalog writes the catalog to disk."""

    def test_writes_catalog_on_change(self, tmp_path):
        env = make_env(tmp_path)
        changes = beacon_sync.sync_data_catalog(env)
        assert changes >= 1  # First write is always a change
        assert (env.data_dir / "catalog.md").exists()

    def test_no_write_when_unchanged(self, tmp_path):
        env = make_env(tmp_path)
        beacon_sync.sync_data_catalog(env)
        changes = beacon_sync.sync_data_catalog(env)
        assert changes == 0  # Second run: no change


class TestStampMapVersion:
    """stamp_map_version adds schema version comment to agent_map.md."""

    def test_adds_comment(self, tmp_path):
        env = make_env(tmp_path)
        # Remove any existing schema comment
        content = env.agent_map.read_text()
        content = content.replace("<!-- agent-env schema: 1.0 -->\n", "")
        env.agent_map.write_text(content)

        beacon_sync.stamp_map_version(env)
        result = env.agent_map.read_text()
        assert "<!-- agent-env schema: 1.0 -->" in result

    def test_idempotent(self, tmp_path):
        env = make_env(tmp_path)
        beacon_sync.stamp_map_version(env)
        first = env.agent_map.read_text()
        beacon_sync.stamp_map_version(env)
        second = env.agent_map.read_text()
        assert first == second