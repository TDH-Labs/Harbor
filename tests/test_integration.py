"""Integration tests — full sync cycle, idempotency, corrupted maps.

These tests exercise beacon_sync's full pipeline (discover → update → generate)
against a real temp directory. No filesystem mocking; only time and subprocess
calls are mocked where necessary.
"""
from __future__ import annotations

import os
import textwrap
from pathlib import Path

import pytest

from agent_env import beacon_sync, mdtables
from agent_env.config import Config
from agent_env.environment import Environment

from tests.helpers import make_env, FULL_AGENT_MAP, make_config, write_skill, write_obsidian_note


# ── Full sync cycle ────────────────────────────────────────────────────────

class TestFullSyncCycle:
    """Discover → update → stamp → generate on a temp tree."""

    def test_full_sync_creates_beacons(self, tmp_path):
        """full_sync() should create all home-level beacon files."""
        env = make_env(tmp_path)
        beacon_sync.full_sync(env)

        for target in env.config.home_beacon_targets:
            path = env.root / target
            assert path.exists(), f"beacon {target} should exist after full_sync"

    def test_full_sync_creates_workspace_beacons(self, tmp_path):
        """full_sync() should create per-project AGENTS.md symlinks."""
        env = make_env(tmp_path)
        # Create a workspace project dir
        proj = env.workspace / "testproject"
        proj.mkdir(parents=True, exist_ok=True)

        beacon_sync.full_sync(env)

        beacon = proj / env.config.project_beacon
        assert beacon.exists() or beacon.is_symlink(), "project beacon should exist"

    def test_full_sync_writes_version(self, tmp_path):
        """full_sync() stamps the schema version in ~/.agent-env/version."""
        env = make_env(tmp_path)
        beacon_sync.full_sync(env)

        assert env.version_file.exists(), "version file should be created"
        version = env.version_file.read_text().strip()
        assert version == env.config.schema_version, f"version stamp should be {env.config.schema_version}"

    def test_full_sync_stamps_agent_map(self, tmp_path):
        """full_sync() stamps a schema version comment into agent_map.md."""
        env = make_env(tmp_path)
        # The minimal agent_map does NOT have the schema comment yet
        content_before = env.agent_map.read_text()
        count_before = content_before.count("<!-- agent-env schema:")

        beacon_sync.full_sync(env)

        content = env.agent_map.read_text()
        assert "<!-- agent-env schema: 1.0 -->" in content, "schema comment should be stamped"
        count_after = content.count("<!-- agent-env schema:")
        assert count_after == count_before + 1, "should add exactly one schema comment"

    def test_full_sync_idempotent(self, tmp_path):
        """Running full_sync twice should produce identical beacon files."""
        env = make_env(tmp_path)
        beacon_sync.full_sync(env)

        # Capture all beacon content
        first_pass = {}
        for target in env.config.home_beacon_targets:
            first_pass[target] = (env.root / target).read_text()

        # Re-run
        beacon_sync.full_sync(env)

        for target in env.config.home_beacon_targets:
            first = first_pass[target]
            second = (env.root / target).read_text()
            # The schema comment is only inserted once, so content should be stable
            assert first == second, f"{target} should be idempotent across runs"

    def test_full_sync_no_hardcoded_paths(self, tmp_path):
        """Generated beacons should reference the environment root, not /Users/ai/."""
        env = make_env(tmp_path)
        beacon_sync.full_sync(env)

        for target in env.config.home_beacon_targets:
            content = (env.root / target).read_text()
            assert "/Users/ai/" not in content, f"{target} should not contain /Users/ai/"
            # Should reference the temp root instead
            assert str(env.root) in content, f"{target} should reference root {env.root}"


# ── Idempotency ────────────────────────────────────────────────────────────

class TestIdempotency:
    """Second run should produce no changes to beacon files."""

    def test_generate_only_idempotent(self, tmp_path):
        """run_generate() called twice should produce identical output."""
        env = make_env(tmp_path)
        beacon_sync.run_generate(env)

        first_pass = {}
        for target in env.config.home_beacon_targets:
            first_pass[target] = (env.root / target).read_text()

        beacon_sync.run_generate(env)

        for target in env.config.home_beacon_targets:
            assert (env.root / target).read_text() == first_pass[target], \
                f"{target} should be identical after second generate"

    def test_version_stamp_idempotent(self, tmp_path):
        """Stamping version twice should not add a second comment."""
        env = make_env(tmp_path)
        beacon_sync.stamp_map_version(env)
        content_after_first = env.agent_map.read_text()
        count_after_first = content_after_first.count("<!-- agent-env schema:")

        beacon_sync.stamp_map_version(env)
        content_after_second = env.agent_map.read_text()
        count_after_second = content_after_second.count("<!-- agent-env schema:")

        assert count_after_first == 1, "should have exactly one schema comment"
        assert count_after_second == 1, "should not add a second schema comment"


# ── Corrupted map handling ────────────────────────────────────────────────

class TestCorruptedMap:
    """beacon_sync should warn or degrade gracefully on malformed agent_map.md."""

    def test_empty_map_exits(self, tmp_path):
        """An empty agent_map.md should cause run_generate to exit."""
        env = make_env(tmp_path)
        env.agent_map.write_text("")
        with pytest.raises(SystemExit):
            beacon_sync.run_generate(env)

    def test_map_with_only_heading(self, tmp_path):
        """A map with just a title (no tables) should succeed without crashing."""
        env = make_env(tmp_path)
        env.agent_map.write_text("# Agent Map\n\nNo tables here.\n")
        # Should not crash — rooms and projects will be empty lists
        beacon_sync.run_generate(env)
        # Verify beacons were written (they'll just have empty room/project tables)
        assert (env.root / "AGENTS.md").exists()

    def test_map_with_malformed_table(self, tmp_path):
        """A map with a broken table (wrong column count) should not crash."""
        env = make_env(tmp_path)
        broken_map = textwrap.dedent("""\
            <!-- agent-env schema: 1.0 -->
            # Agent Map

            ## Available Rooms

            | Room | Path |
            |------|------|
            | Research | ~/rooms/research/ | Papers, analysis, extra column |

            ## Active Projects

            | Project | Path |
            |---------|------|
            | TestProject | ~/workspace/testproject/ |

            ## Security

            - Root scope: the environment root.
        """)
        env.agent_map.write_text(broken_map)
        # Should not crash, may skip malformed rows
        beacon_sync.run_generate(env)

    def test_map_with_duplicate_rooms(self, tmp_path):
        """Duplicate room entries should be handled without crash."""
        env = make_env(tmp_path)
        dup_map = textwrap.dedent("""\
            <!-- agent-env schema: 1.0 -->
            # Agent Map

            ## Available Rooms

            | Room | Path | Purpose |
            |------|------|---------|
            | Research | ~/rooms/research/ | Papers |
            | Research | ~/rooms/research/ | Analysis |

            ## Active Projects

            | Project | Path | Status |
            |---------|------|--------|
            | TestProject | ~/workspace/testproject/ | Active |

            ## Security

            - Root scope: the environment root.
        """)
        env.agent_map.write_text(dup_map)
        beacon_sync.run_generate(env)
        assert (env.root / "AGENTS.md").exists()

    def test_map_missing_security_section(self, tmp_path):
        """A map without a Security section should still work."""
        env = make_env(tmp_path)
        minimal_map = textwrap.dedent("""\
            # Agent Map

            ## Available Rooms

            | Room | Path | Purpose |
            |------|------|---------|
            | DevOps | ~/rooms/devops/ | Infrastructure |

            ## Active Projects

            | Project | Path | Status |
            |---------|------|--------|
            | MyProject | ~/workspace/myproject/ | Active |
        """)
        env.agent_map.write_text(minimal_map)
        beacon_sync.run_generate(env)
        assert (env.root / "AGENTS.md").exists()


# ── Project discovery ──────────────────────────────────────────────────────

class TestDiscovery:
    """Project discovery against a temp directory tree."""

    def test_discover_workspace_projects(self, tmp_path):
        """discover_workspace_projects finds workspace subdirectories."""
        env = make_env(tmp_path)
        # Create two project dirs
        (env.workspace / "proj-a").mkdir(parents=True, exist_ok=True)
        (env.workspace / "proj-b").mkdir(parents=True, exist_ok=True)

        found = beacon_sync.discover_workspace_projects(env)
        names = [p.name for p in found]
        assert "proj-a" in names
        assert "proj-b" in names

    def test_discover_home_projects(self, tmp_path):
        """discover_home_projects finds project dirs at the root."""
        env = make_env(tmp_path)
        # Create a project dir at root with a signature file
        proj = tmp_path / "my-project"
        proj.mkdir()
        (proj / ".git").mkdir()

        found = beacon_sync.discover_home_projects(env)
        names = [p.name for p in found]
        assert "my-project" in names

    def test_is_project_dir_with_git(self, tmp_path):
        """A directory with .git is recognized as a project."""
        env = make_env(tmp_path)
        proj = tmp_path / "myproj"
        proj.mkdir()
        (proj / ".git").mkdir()
        assert beacon_sync.is_project_dir(env, proj)

    def test_is_project_dir_with_agents_md(self, tmp_path):
        """A directory with AGENTS.md is recognized as a project."""
        env = make_env(tmp_path)
        proj = tmp_path / "myproj"
        proj.mkdir()
        (proj / "AGENTS.md").write_text("# Beacon\n")
        assert beacon_sync.is_project_dir(env, proj)

    def test_skip_dirs_excluded(self, tmp_path):
        """Directories in skip_dirs should not be projects, even with .git."""
        env = make_env(tmp_path)
        # 'scripts' is in the default skip_dirs
        scripts = tmp_path / "scripts"
        scripts.mkdir()
        (scripts / ".git").mkdir()
        assert not beacon_sync.is_project_dir(env, scripts)

    def test_hidden_dirs_excluded(self, tmp_path):
        """Hidden directories (starting with .) should not be projects."""
        env = make_env(tmp_path)
        hidden = tmp_path / ".hidden-project"
        hidden.mkdir()
        (hidden / ".git").mkdir()
        assert not beacon_sync.is_project_dir(env, hidden)


# ── Beacon generation ──────────────────────────────────────────────────────

class TestBeaconGeneration:
    """Verify content of generated beacons."""

    def test_home_agents_md_says_5_layer(self, tmp_path):
        """Generated AGENTS.md must say '5-layer', not '3-layer'."""
        env = make_env(tmp_path)
        beacon_sync.run_generate(env)
        content = (env.root / "AGENTS.md").read_text()
        assert "5-layer" in content, "AGENTS.md must mention 5-layer"
        assert "3-layer" not in content, "AGENTS.md must NOT mention 3-layer"

    def test_home_agents_md_has_rooms(self, tmp_path):
        """Generated AGENTS.md includes the rooms from agent_map.md."""
        env = make_env(tmp_path)
        beacon_sync.run_generate(env)
        content = (env.root / "AGENTS.md").read_text()
        assert "Research" in content, "AGENTS.md should mention Research room"
        assert "Writing" in content, "AGENTS.md should mention Writing room"

    def test_home_agents_md_has_root_path(self, tmp_path):
        """Generated AGENTS.md references the environment root path."""
        env = make_env(tmp_path)
        beacon_sync.run_generate(env)
        content = (env.root / "AGENTS.md").read_text()
        assert str(env.root) in content, "AGENTS.md should reference root path"

    def test_claude_md_says_agents_skills(self, tmp_path):
        """CLAUDE.md should reference the canonical skill store from config."""
        env = make_env(tmp_path)
        beacon_sync.run_generate(env)
        content = (env.root / "CLAUDE.md").read_text()
        # Default config says skills_dir is ~/.agents/skills
        # After resolution, it should reference the skills directory
        assert "skills" in content.lower(), "CLAUDE.md should mention skills"

    def test_cursorrules_lists_rooms(self, tmp_path):
        """Generated .cursorrules lists rooms from agent_map.md."""
        env = make_env(tmp_path)
        beacon_sync.run_generate(env)
        content = (env.root / ".cursorrules").read_text()
        # Should contain room slugs
        assert "research" in content.lower(), ".cursorrules should list rooms"
        assert "writing" in content.lower(), ".cursorrules should list rooms"

    def test_project_agents_md_symlink(self, tmp_path):
        """Per-project AGENTS.md should be a symlink to the home beacon."""
        env = make_env(tmp_path)
        proj = env.workspace / "testproject"
        proj.mkdir(parents=True, exist_ok=True)

        beacon_sync.run_generate(env)

        project_beacon = proj / env.config.project_beacon
        assert project_beacon.is_symlink() or project_beacon.exists(), \
            "project beacon should exist"
        if project_beacon.is_symlink():
            target = os.readlink(str(project_beacon))
            assert str(env.root / "AGENTS.md") in target or "AGENTS.md" in target


# ── Hygiene ──────────────────────────────────────────────────────────────

class TestHygiene:
    """Non-destructive hygiene tasks: symlinks, data catalog, Obsidian index."""

    def test_report_broken_symlinks(self, tmp_path):
        """report_broken_symlinks detects broken symlinks in workspace."""
        env = make_env(tmp_path)
        proj = env.workspace / "broken-proj"
        proj.mkdir(parents=True, exist_ok=True)
        broken = proj / "broken_link"
        broken.symlink_to("/nonexistent/path/that/does/not/exist")

        count = beacon_sync.report_broken_symlinks(env)
        assert count >= 1, "should detect broken symlink"

    def test_sync_data_catalog_empty(self, tmp_path):
        """With no databases, build_data_catalog returns the template."""
        env = make_env(tmp_path)
        content, db_count = beacon_sync.build_data_catalog(env)
        assert db_count == 0, "empty data dir should have 0 databases"
        assert "Example A" in content, "template should contain placeholders"

    def test_sync_data_catalog_with_db(self, tmp_path):
        """With a real SQLite database, build_data_catalog includes it."""
        env = make_env(tmp_path)
        import sqlite3

        # Create a test database
        db_dir = env.data_dir / "testdomain"
        db_dir.mkdir(parents=True, exist_ok=True)
        db_path = db_dir / "testdomain.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO records (name) VALUES ('test')")
        conn.commit()
        conn.close()

        content, db_count = beacon_sync.build_data_catalog(env)
        assert db_count == 1
        assert "testdomain" in content

    def test_sync_obsidian_index_empty(self, tmp_path):
        """With no Obsidian notes, the index should report 0 notes."""
        from agent_env import sync_obsidian_index
        env = make_env(tmp_path)
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 0

    def test_sync_obsidian_index_with_note(self, tmp_path):
        """With notes in the vault, scan_vault finds them."""
        from agent_env import sync_obsidian_index
        env = make_env(tmp_path)
        write_obsidian_note(env, "Research/test-note.md",
                           title="Test Note",
                           frontmatter="type: concept\ndomain: research",
                           body="This is a test note.")
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 1
        assert entries[0]["title"] == "Test Note"


# ── Run discovery + update pipeline ──────────────────────────────────────

class TestDiscoveryUpdatePipeline:
    """Test the discover → update pipeline (run_discovery + run_update)."""

    def test_discover_new_workspace_project(self, tmp_path):
        """New workspace dirs are discovered and reported."""
        env = make_env(tmp_path)
        proj = env.workspace / "new-project"
        proj.mkdir(parents=True, exist_ok=True)

        workspace_dirs, untracked, in_map_not_workspace = beacon_sync.run_discovery(env)
        names = [d.name for d in workspace_dirs]
        assert "new-project" in names

    def test_update_adds_project_to_map(self, tmp_path):
        """run_update adds new projects to agent_map.md."""
        env = make_env(tmp_path)
        proj = env.workspace / "new-project"
        proj.mkdir(parents=True, exist_ok=True)

        workspace_dirs, untracked, in_map_not_workspace = beacon_sync.run_discovery(env)
        beacon_sync.run_update(env, workspace_dirs, untracked, in_map_not_workspace)

        content = env.agent_map.read_text()
        assert "new-project" in content, "new project should be added to agent_map"


# ── Extract path slug ─────────────────────────────────────────────────────

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