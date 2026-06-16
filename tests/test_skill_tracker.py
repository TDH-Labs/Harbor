"""Tests for agent_env/skill_tracker.py — usage logging, stats, room index rebuild."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from agent_env import skill_tracker
from agent_env.config import Config, DEFAULTS
from agent_env.environment import Environment

from tests.helpers import make_env, make_config


class TestLogUsage:
    """log_usage appends a timestamped entry to the usage log."""

    def test_creates_log_file(self, tmp_path):
        env = make_env(tmp_path)
        skill_tracker.log_usage(env, "my-skill")
        log_path = env.skills_dir / "_usage_log.jsonl"
        assert log_path.exists()

    def test_appends_entry(self, tmp_path):
        env = make_env(tmp_path)
        skill_tracker.log_usage(env, "my-skill")
        skill_tracker.log_usage(env, "other-skill")
        log_path = env.skills_dir / "_usage_log.jsonl"
        lines = log_path.read_text().strip().split("\n")
        assert len(lines) == 2

    def test_entry_format(self, tmp_path):
        env = make_env(tmp_path)
        skill_tracker.log_usage(env, "test-skill")
        log_path = env.skills_dir / "_usage_log.jsonl"
        entry = json.loads(log_path.read_text().strip())
        assert entry["skill"] == "test-skill"
        assert "timestamp" in entry
        assert "epoch" in entry


class TestGetUsageStats:
    """get_usage_stats computes per-skill usage counts and recency."""

    def test_empty_log(self, tmp_path):
        env = make_env(tmp_path)
        stats = skill_tracker.get_usage_stats(env)
        assert stats == {}

    def test_single_entry(self, tmp_path):
        env = make_env(tmp_path)
        skill_tracker.log_usage(env, "my-skill")
        stats = skill_tracker.get_usage_stats(env)
        assert "my-skill" in stats
        assert stats["my-skill"]["total"] == 1
        assert stats["my-skill"]["recent"] >= 1
        assert stats["my-skill"]["last_used"] > 0

    def test_multiple_entries(self, tmp_path):
        env = make_env(tmp_path)
        skill_tracker.log_usage(env, "skill-a")
        skill_tracker.log_usage(env, "skill-b")
        skill_tracker.log_usage(env, "skill-a")
        stats = skill_tracker.get_usage_stats(env)
        assert stats["skill-a"]["total"] == 2
        assert stats["skill-b"]["total"] == 1

    def test_recent_count(self, tmp_path):
        env = make_env(tmp_path)
        skill_tracker.log_usage(env, "my-skill")
        stats = skill_tracker.get_usage_stats(env)
        assert stats["my-skill"]["recent"] == 1

    def test_missing_log_file(self, tmp_path):
        env = make_env(tmp_path)
        # Don't write anything - log file doesn't exist yet
        stats = skill_tracker.get_usage_stats(env)
        assert stats == {}

    def test_malformed_lines_skipped(self, tmp_path):
        env = make_env(tmp_path)
        log_path = env.skills_dir / "_usage_log.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("not json\n\ncorrupt\n")
        stats = skill_tracker.get_usage_stats(env)
        assert stats == {}


class TestPrintStats:
    """print_stats outputs usage stats to stdout."""

    def test_prints_stats(self, tmp_path, capsys):
        env = make_env(tmp_path)
        skill_tracker.log_usage(env, "my-skill")
        skill_tracker.print_stats(env)
        output = capsys.readouterr().out
        assert "my-skill" in output

    def test_empty_stats(self, tmp_path, capsys):
        env = make_env(tmp_path)
        skill_tracker.print_stats(env)
        output = capsys.readouterr().out
        assert "No usage data" in output


class TestRebuildRoomIndexes:
    """rebuild_room_indexes updates skill indexes with usage data."""

    def test_rebuild_with_existing_index(self, tmp_path):
        env = make_env(tmp_path)
        # Create a room with an existing skills_index.md
        room_dir = env.rooms / "research"
        room_dir.mkdir(parents=True, exist_ok=True)
        index_path = room_dir / "skills_index.md"
        index_path.write_text("""# Research Skills Index

> Research, analysis
> Skills in this room: 1

| Skill | Description |
|-------|-------------|
| my-skill | A test skill |
""")
        # Log skill usage
        skill_tracker.log_usage(env, "my-skill")

        result = skill_tracker.rebuild_room_indexes(env)
        # Should update the index with a "Last Used" column
        updated = index_path.read_text()
        assert "Last Used" in updated

    def test_rebuild_empty_rooms(self, tmp_path):
        env = make_env(tmp_path)
        # No room directories exist
        result = skill_tracker.rebuild_room_indexes(env)
        assert result == 0

    def test_rebuild_skips_rooms_without_index(self, tmp_path):
        env = make_env(tmp_path)
        room_dir = env.rooms / "research"
        room_dir.mkdir(parents=True, exist_ok=True)
        # No skills_index.md in this room
        result = skill_tracker.rebuild_room_indexes(env)
        assert result == 0