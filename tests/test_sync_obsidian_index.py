"""Tests for agent_env/sync_obsidian_index.py — vault scanning, frontmatter, Key Numbers."""
from __future__ import annotations

from pathlib import Path

import pytest

from agent_env import sync_obsidian_index
from agent_env.config import Config
from agent_env.environment import Environment

from tests.helpers import make_env, write_obsidian_note


class TestParseFrontmatter:
    """parse_frontmatter extracts YAML frontmatter as a dict."""

    def test_basic_frontmatter(self):
        text = "---\ntitle: Test\ndomain: research\n---\n\nContent"
        result = sync_obsidian_index.parse_frontmatter(text)
        assert result["title"] == "Test"
        assert result["domain"] == "research"

    def test_quoted_values(self):
        text = '---\ntitle: "My Note"\n---\n'
        result = sync_obsidian_index.parse_frontmatter(text)
        assert result["title"] == "My Note"

    def test_single_quoted_values(self):
        text = "---\ntitle: 'My Note'\n---\n"
        result = sync_obsidian_index.parse_frontmatter(text)
        assert result["title"] == "My Note"

    def test_no_frontmatter(self):
        result = sync_obsidian_index.parse_frontmatter("Just content")
        assert result == {}

    def test_unclosed_frontmatter(self):
        text = "---\ntitle: Test\nNo closing"
        result = sync_obsidian_index.parse_frontmatter(text)
        assert result == {}

    def test_empty_frontmatter(self):
        text = "---\n---\nContent"
        result = sync_obsidian_index.parse_frontmatter(text)
        assert result == {}


class TestExtractHeadings:
    """extract_headings gets the first H1 heading."""

    def test_extracts_h1(self):
        text = "# My Note\n\nSome content"
        assert sync_obsidian_index.extract_headings(text) == "My Note"

    def test_skips_h2(self):
        text = "## Sub Heading\n\nContent"
        assert sync_obsidian_index.extract_headings(text) == ""

    def test_first_h1_wins(self):
        text = "# First\n\n## Sub\n\n# Second"
        assert sync_obsidian_index.extract_headings(text) == "First"

    def test_no_heading(self):
        assert sync_obsidian_index.extract_headings("Just text") == ""


class TestExtractKeyNumbers:
    """extract_key_numbers pulls the Key Numbers section."""

    def test_basic_key_numbers(self):
        text = "# Note\n\nKey Numbers\nRevenue: $10M\nGrowth: 15%\n\n## Next Section"
        result = sync_obsidian_index.extract_key_numbers(text)
        assert "Revenue: $10M" in result
        assert "Growth: 15%" in result

    def test_no_key_numbers(self):
        text = "# Note\n\nJust content\n"
        result = sync_obsidian_index.extract_key_numbers(text)
        assert result == ""

    def test_key_numbers_at_end(self):
        text = "# Note\n\nKey Numbers\nRevenue: $10M"
        result = sync_obsidian_index.extract_key_numbers(text)
        assert "Revenue: $10M" in result


class TestScanVault:
    """scan_vault discovers .md files and extracts metadata."""

    def test_empty_vault(self, tmp_path):
        env = make_env(tmp_path)
        entries = sync_obsidian_index.scan_vault(env)
        assert entries == []

    def test_single_note(self, tmp_path):
        env = make_env(tmp_path)
        write_obsidian_note(env, "Research/note.md",
                           title="Test Note",
                           frontmatter="type: concept\ndomain: research",
                           body="Some content")
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 1
        assert entries[0]["title"] == "Test Note"
        assert entries[0]["type"] == "concept"
        assert entries[0]["domain"] == "research"

    def test_skips_obsidian_config(self, tmp_path):
        env = make_env(tmp_path)
        (env.obsidian / ".obsidian").mkdir(parents=True, exist_ok=True)
        (env.obsidian / ".obsidian" / "config").write_text("config")
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 0

    def test_skips_templates(self, tmp_path):
        env = make_env(tmp_path)
        (env.obsidian / "_templates").mkdir(parents=True, exist_ok=True)
        (env.obsidian / "_templates" / "tpl.md").write_text("# Template\n")
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 0

    def test_detects_wikilinks(self, tmp_path):
        env = make_env(tmp_path)
        write_obsidian_note(env, "Research/linked.md",
                           title="Linked Note",
                           body="See [[Other Note]] for details.")
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 1
        assert entries[0]["has_links"] is True

    def test_no_wikilinks(self, tmp_path):
        env = make_env(tmp_path)
        write_obsidian_note(env, "Research/plain.md",
                           title="Plain Note",
                           body="Just plain text.")
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 1
        assert entries[0]["has_links"] is False

    def test_multiple_notes(self, tmp_path):
        env = make_env(tmp_path)
        for i in range(5):
            write_obsidian_note(env, f"Note{i}.md", title=f"Note {i}")
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 5

    def test_note_with_connections(self, tmp_path):
        env = make_env(tmp_path)
        write_obsidian_note(env, "Research/connected.md",
                           title="Connected",
                           connections=["Alpha", "Beta"])
        entries = sync_obsidian_index.scan_vault(env)
        assert len(entries) == 1
        assert "Alpha" in entries[0]["connected_to"] or "[[Alpha]]" in entries[0]["connected_to"]


class TestBuildIndex:
    """build_index produces the _index.md content."""

    def test_empty_vault(self, tmp_path):
        env = make_env(tmp_path)
        entries = sync_obsidian_index.scan_vault(env)
        content = sync_obsidian_index.build_index(entries)
        assert "Obsidian Vault Index" in content

    def test_with_entries(self, tmp_path):
        env = make_env(tmp_path)
        write_obsidian_note(env, "Research/test.md",
                           title="Test Note",
                           frontmatter="type: concept\ndomain: research")
        entries = sync_obsidian_index.scan_vault(env)
        content = sync_obsidian_index.build_index(entries)
        assert "Test Note" in content
        assert "concept" in content

    def test_concept_graph_with_connections(self, tmp_path):
        env = make_env(tmp_path)
        write_obsidian_note(env, "Research/a.md",
                           title="Alpha",
                           connections=["Beta"])
        entries = sync_obsidian_index.scan_vault(env)
        content = sync_obsidian_index.build_index(entries)
        assert "Concept Graph" in content
        assert "Alpha" in content
        assert "Beta" in content


class TestSync:
    """sync() writes the _index.md file."""

    def test_sync_creates_index(self, tmp_path):
        env = make_env(tmp_path)
        result = sync_obsidian_index.sync(env)
        assert result >= 1  # First sync is always a change
        assert (env.obsidian / "_index.md").exists()

    def test_sync_idempotent(self, tmp_path):
        """Second sync on an empty vault is byte-identical modulo timestamp.

        _index.md is excluded from scanning, so its creation during the first
        sync is not discovered during the second, keeping note counts stable."""
        import re
        env = make_env(tmp_path)
        sync_obsidian_index.sync(env)
        first_content = (env.obsidian / "_index.md").read_text()
        sync_obsidian_index.sync(env)
        second_content = (env.obsidian / "_index.md").read_text()

        ts_pattern = re.compile(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}')
        first_norm = ts_pattern.sub("<TS>", first_content)
        second_norm = ts_pattern.sub("<TS>", second_content)
        assert first_norm == second_norm  # byte-identical modulo timestamp

    def test_sync_after_change(self, tmp_path):
        env = make_env(tmp_path)
        sync_obsidian_index.sync(env)
        # Add a note
        write_obsidian_note(env, "New.md", title="New Note")
        result = sync_obsidian_index.sync(env)
        assert result == 1  # Change detected