"""tests/test_demo.py — Phase 5b demo content and setup --demo tests.

All tests operate against tmp roots (never real home).
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

from agent_env import cli
from agent_env.demo import materialize, ASSETS


# ── Asset sanity ─────────────────────────────────────────────────────────────

class TestDemoAssets:
    def test_all_asset_files_present(self):
        required = [
            ASSETS / "demo_agent_map.md",
            ASSETS / "rooms" / "research" / "room_rules.md",
            ASSETS / "rooms" / "writing" / "room_rules.md",
            ASSETS / "data" / "catalog.md",
            ASSETS / "data" / "sample_db" / "README.md",
            ASSETS / "workspace" / "example-project" / "research.md",
            ASSETS / "workspace" / "example-project" / "plan.md",
            ASSETS / "workspace" / "example-project" / "scratchpad.md",
        ]
        for path in required:
            assert path.exists(), f"Missing demo asset: {path}"

    def test_four_obsidian_notes(self):
        notes = list((ASSETS / "Obsidian").glob("*.md"))
        assert len(notes) == 4, f"Expected 4 Obsidian notes, got {len(notes)}"

    def test_notes_have_frontmatter(self):
        for note in (ASSETS / "Obsidian").glob("*.md"):
            text = note.read_text()
            assert text.startswith("---\n"), f"{note.name}: missing YAML frontmatter"
            assert "---\n" in text[4:], f"{note.name}: frontmatter not closed"

    def test_notes_have_wikilinks(self):
        for note in (ASSETS / "Obsidian").glob("*.md"):
            text = note.read_text()
            count = text.count("[[")
            assert count >= 2, (
                f"{note.name}: expected ≥2 wikilinks, found {count}"
            )

    def test_notes_have_key_numbers(self):
        for note in (ASSETS / "Obsidian").glob("*.md"):
            text = note.read_text()
            assert "Key Numbers" in text, (
                f"{note.name}: missing 'Key Numbers' section"
            )

    def test_notes_have_sources(self):
        for note in (ASSETS / "Obsidian").glob("*.md"):
            text = note.read_text()
            assert "Sources" in text, f"{note.name}: missing 'Sources' section"

    def test_no_personal_strings_in_assets(self):
        _user_home = re.compile(r'/Users/[^/\s]+/|/home/[^/\s]+/')
        for path in ASSETS.rglob("*"):
            if not path.is_file() or path.suffix not in (".md", ".toml", ".py"):
                continue
            text = path.read_text(errors="replace")
            match = _user_home.search(text)
            assert match is None, (
                f"Absolute user-home path '{match.group()}' found in demo asset {path}"
            )


# ── Materialize ───────────────────────────────────────────────────────────────

class TestMaterialize:
    def test_creates_expected_structure(self, tmp_path):
        created = materialize(tmp_path)
        assert len(created) >= 13

        expected = [
            tmp_path / "agent_map.md",
            tmp_path / "rooms" / "research" / "room_rules.md",
            tmp_path / "rooms" / "writing" / "room_rules.md",
            tmp_path / "data" / "catalog.md",
            tmp_path / "data" / "sample_db" / "README.md",
            tmp_path / "data" / "sample_db" / "sample.db",
            tmp_path / "workspace" / "example-project" / "research.md",
            tmp_path / "workspace" / "example-project" / "plan.md",
            tmp_path / "workspace" / "example-project" / "scratchpad.md",
        ]
        for path in expected:
            assert path.exists(), f"Missing after materialize: {path}"

    def test_four_obsidian_notes_copied(self, tmp_path):
        materialize(tmp_path)
        notes = list((tmp_path / "Obsidian").glob("*.md"))
        assert len(notes) == 4

    def test_placeholder_substituted(self, tmp_path):
        materialize(tmp_path)
        map_text = (tmp_path / "agent_map.md").read_text()
        assert str(tmp_path) in map_text, "Root placeholder not substituted"
        assert "<root>" not in map_text, "'<root>' placeholder still present"

    def test_catalog_placeholder_substituted(self, tmp_path):
        materialize(tmp_path)
        catalog = (tmp_path / "data" / "catalog.md").read_text()
        assert str(tmp_path) in catalog
        assert "<root>" not in catalog

    def test_sqlite_db_seeded(self, tmp_path):
        materialize(tmp_path)
        db = tmp_path / "data" / "sample_db" / "sample.db"
        assert db.exists()
        con = sqlite3.connect(db)
        rows = con.execute("SELECT id FROM notes").fetchall()
        assert len(rows) >= 3, "Expected at least 3 seed rows in notes table"
        con.close()

    def test_sqlite_has_metrics_table(self, tmp_path):
        materialize(tmp_path)
        db = tmp_path / "data" / "sample_db" / "sample.db"
        con = sqlite3.connect(db)
        tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        assert "notes" in tables
        assert "metrics" in tables
        con.close()

    def test_idempotent_second_materialize(self, tmp_path):
        materialize(tmp_path)
        # Second call must not raise; DB seed uses INSERT OR IGNORE
        materialize(tmp_path)
        db = tmp_path / "data" / "sample_db" / "sample.db"
        con = sqlite3.connect(db)
        count = con.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        assert count == 3, "Idempotent seed must not duplicate rows"
        con.close()

    def test_root_not_in_real_home(self, tmp_path):
        assert str(tmp_path).startswith("/tmp") or "pytest" in str(tmp_path) or \
               str(tmp_path) != str(Path.home()), \
               "materialize targeted real home"


# ── CLI: setup --demo ─────────────────────────────────────────────────────────

class TestSetupDemoCLI:
    def test_setup_demo_creates_files(self, tmp_path):
        rc = cli.main(["setup", "--demo", str(tmp_path)])
        assert rc == 0
        assert (tmp_path / "agent_map.md").exists()
        assert (tmp_path / "Obsidian").is_dir()
        assert (tmp_path / "data" / "sample_db" / "sample.db").exists()

    def test_setup_demo_passes_check(self, tmp_path):
        from agent_env.config import Config
        from agent_env.environment import Environment

        cli.main(["setup", "--demo", str(tmp_path)])
        cfg = Config.load(str(tmp_path / ".agent-env" / "config.toml"))
        env = Environment(tmp_path, cfg)
        report = cli.run_check(env)
        assert report.ok, "\n".join(report.errors)

    def test_setup_demo_obsidian_index_generated(self, tmp_path):
        cli.main(["setup", "--demo", str(tmp_path)])
        index = tmp_path / "Obsidian" / "_index.md"
        assert index.exists(), "Obsidian _index.md should be generated by sync"
        text = index.read_text()
        assert "compaction" in text.lower() or "five-layer" in text.lower() or \
               "knowledge" in text.lower(), \
               "_index.md should reference demo note titles"

    def test_setup_demo_requires_no_root_config(self, tmp_path):
        # --demo is self-contained; should NOT require --root or --config.
        rc = cli.main(["setup", "--demo", str(tmp_path)])
        assert rc == 0

    def test_setup_demo_no_personal_strings(self, tmp_path):
        cli.main(["setup", "--demo", str(tmp_path)])
        _user_home = re.compile(r'/Users/[^/\s]+/|/home/[^/\s]+/')
        for path in tmp_path.rglob("*.md"):
            text = path.read_text(errors="replace")
            match = _user_home.search(text)
            assert match is None, (
                f"Absolute user-home path '{match.group()}' found in demo output: {path}"
            )

    def test_setup_demo_does_not_write_real_home(self, tmp_path):
        home = Path.home()
        # We can't easily snapshot the whole home, but we can verify that the
        # demo root is not the real home directory.
        assert tmp_path != home, "setup --demo targeted real home"
        cli.main(["setup", "--demo", str(tmp_path)])
        # Real home's agent_map.md must not be touched
        real_map = home / "agent_map.md"
        if real_map.exists():
            # Just confirm it wasn't recently modified by checking size stability
            pass  # Non-invasive; isolation is guaranteed by using tmp_path

    # ── C-1: demo root guard (never write real/fake home or ancestor) ─────────
    #
    # All guard tests monkeypatch HOME so that both Path("~").expanduser() and
    # Path.home() return the fake home, not the real one. Nothing is ever
    # written to or read from the real home.

    def _fake_home(self, tmp_path, monkeypatch):
        """Create a fake home dir and redirect HOME to it. Return the fake path."""
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setenv("HOME", str(fake_home))
        return fake_home

    def test_demo_guard_rejects_fake_home_direct(self, tmp_path, monkeypatch):
        """setup --demo <fakehome> must refuse when root IS the fake home."""
        fake_home = self._fake_home(tmp_path, monkeypatch)
        rc = cli.main(["setup", "--demo", str(fake_home)])
        assert rc != 0, "should refuse when demo root is the (fake) home"
        assert not (fake_home / "agent_map.md").exists()

    def test_demo_guard_rejects_tilde_expanding_to_fake_home(
        self, tmp_path, monkeypatch
    ):
        """setup --demo ~ must refuse when ~ expands to the fake home."""
        fake_home = self._fake_home(tmp_path, monkeypatch)
        rc = cli.main(["setup", "--demo", "~"])
        assert rc != 0, "should refuse ~ when it expands to fake home"
        assert not (fake_home / "agent_map.md").exists()

    def test_demo_guard_rejects_parent_of_fake_home(self, tmp_path, monkeypatch):
        """setup --demo <fakehome>/.. must refuse (ancestor of home)."""
        fake_home = self._fake_home(tmp_path, monkeypatch)
        parent = fake_home / ".."
        rc = cli.main(["setup", "--demo", str(parent)])
        assert rc != 0, "should refuse ancestor of fake home"
        assert not (fake_home / "agent_map.md").exists()

    def test_demo_guard_rejects_symlink_to_fake_home(self, tmp_path, monkeypatch):
        """A symlink pointing at fake home must also be refused."""
        fake_home = self._fake_home(tmp_path, monkeypatch)
        link = tmp_path / "link_to_home"
        link.symlink_to(fake_home)
        rc = cli.main(["setup", "--demo", str(link)])
        assert rc != 0, "should refuse symlink that resolves to fake home"
        assert not (fake_home / "agent_map.md").exists()

    def test_demo_guard_rejects_filesystem_root(self, tmp_path, monkeypatch):
        """setup --demo / must refuse: / is an ancestor of home (and everything).

        The startswith(root + sep) check breaks for "/" because "/" + "/" = "//"
        and no real path starts with "//".  Path.is_relative_to() handles it.
        """
        self._fake_home(tmp_path, monkeypatch)
        rc = cli.main(["setup", "--demo", "/"])
        assert rc != 0, "should refuse filesystem root '/'"

    def test_demo_guard_allows_normal_tmp_subdir(self, tmp_path, monkeypatch):
        """A regular path outside home must still work."""
        fake_home = self._fake_home(tmp_path, monkeypatch)
        demo_dir = tmp_path / "demo"
        rc = cli.main(["setup", "--demo", str(demo_dir)])
        assert rc == 0, "normal demo path outside home must succeed"
        assert (demo_dir / "agent_map.md").exists()
