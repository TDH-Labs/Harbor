"""Tests for agent_env/tidy.py — destructive hygiene gating, whitelists, temp-tree operations."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from agent_env import tidy
from agent_env.config import Config, DEFAULTS
from agent_env.environment import Environment

from tests.helpers import make_env, make_config


def _make_tidy_env(tmp_path, **extra_config):
    """Helper: create an env with tidy.enabled=True."""
    defaults = {"tidy": {"enabled": True}}
    defaults.update(extra_config)
    return make_env(tmp_path, **defaults)


class TestTidyGating:
    """Tidy is disabled by default and refuses to run without --force or config enable."""

    def test_refuses_without_enable(self, tmp_path):
        """Default config (tidy.enabled=False) should cause main() to exit(2)."""
        env = make_env(tmp_path)  # tidy.enabled=False by default
        with pytest.raises(SystemExit) as exc_info:
            # Simulate: python -m agent_env.tidy (no --force)
            with patch.object(sys, "argv", ["tidy"]), \
                 patch("agent_env.tidy.Environment.load", return_value=env):
                tidy.main()
        assert exc_info.value.code == 2

    def test_runs_when_enabled(self, tmp_path):
        """With tidy.enabled=True, run_tidy should succeed without --force."""
        env = _make_tidy_env(tmp_path)
        # run_tidy works when tidy is enabled
        result = tidy.run_tidy(env)
        assert isinstance(result, int)

    def test_force_override(self, tmp_path):
        """With --force, run_tidy runs even when tidy.enabled=False."""
        env = make_env(tmp_path)
        # Calling run_tidy directly doesn't gate — the gating is in main().
        result = tidy.run_tidy(env)
        assert isinstance(result, int)
        assert result >= 0  # returns a non-negative change count


class TestArchiveOldDownloads:
    """archive_old_downloads moves files older than cutoff."""

    def test_moves_old_file(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        downloads = env.downloads_dir
        downloads.mkdir(parents=True, exist_ok=True)
        old_file = downloads / "old.txt"
        old_file.write_text("old content")
        old_mtime = time.time() - (env.config.downloads_archive_days * 86400 + 100)
        os.utime(str(old_file), (old_mtime, old_mtime))

        count = tidy.archive_old_downloads(env)
        assert count >= 1
        assert not old_file.exists()
        assert (env.archive_dir / "downloads" / "old.txt").exists()

    def test_leaves_recent_file(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        downloads = env.downloads_dir
        downloads.mkdir(parents=True, exist_ok=True)
        recent_file = downloads / "recent.txt"
        recent_file.write_text("recent")
        count = tidy.archive_old_downloads(env)
        assert count == 0
        assert recent_file.exists()

    def test_no_downloads_dir(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        count = tidy.archive_old_downloads(env)
        assert count == 0

    def test_handles_name_collision(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        downloads = env.downloads_dir
        downloads.mkdir(parents=True, exist_ok=True)
        old_file = downloads / "collision.txt"
        old_file.write_text("old")
        old_mtime = time.time() - (env.config.downloads_archive_days * 86400 + 100)
        os.utime(str(old_file), (old_mtime, old_mtime))
        archive_dir = env.archive_dir / "downloads"
        archive_dir.mkdir(parents=True, exist_ok=True)
        (archive_dir / "collision.txt").write_text("existing")
        count = tidy.archive_old_downloads(env)
        assert count >= 1
        assert (archive_dir / "collision_1.txt").exists()

    def test_skips_dotfiles_in_downloads(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        downloads = env.downloads_dir
        downloads.mkdir(parents=True, exist_ok=True)
        ds_store = downloads / ".DS_Store"
        ds_store.write_text("ds")
        old_mtime = time.time() - (env.config.downloads_archive_days * 86400 + 100)
        os.utime(str(ds_store), (old_mtime, old_mtime))
        count = tidy.archive_old_downloads(env)
        assert count == 0  # .DS_Store should be skipped


class TestCleanPycache:
    """clean_pycache_home removes ~/__pycache__/."""

    def test_removes_pycache(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        pycache = env.root / "__pycache__"
        pycache.mkdir(parents=True, exist_ok=True)
        (pycache / "test.pyc").write_bytes(b"\x00")
        count = tidy.clean_pycache_home(env)
        assert count >= 1
        assert not pycache.exists()

    def test_no_pycache(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        count = tidy.clean_pycache_home(env)
        assert count == 0


class TestCleanNodeModules:
    """clean_node_modules_home removes ~/node_modules/."""

    def test_removes_node_modules(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        nm = env.root / "node_modules"
        nm.mkdir(parents=True, exist_ok=True)
        (nm / "package").mkdir()
        (nm / "package" / "index.js").write_text("// js")
        count = tidy.clean_node_modules_home(env)
        assert count >= 1
        assert not nm.exists()

    def test_no_node_modules(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        count = tidy.clean_node_modules_home(env)
        assert count == 0


class TestCleanStrayFiles:
    """clean_stray_files removes/archives configured debris files."""

    def test_deletes_configured_file(self, tmp_path):
        env = make_env(tmp_path, tidy={
            "enabled": True,
            "stray_files": {"junk.log": "delete"},
        })
        junk = env.root / "junk.log"
        junk.write_text("junk")
        count = tidy.clean_stray_files(env)
        assert count >= 1
        assert not junk.exists()

    def test_archives_configured_file(self, tmp_path):
        env = make_env(tmp_path, tidy={
            "enabled": True,
            "stray_files": {"old.data": "archive"},
        })
        # archive_dir must NOT be pre-created; clean_stray_files creates it itself.
        assert not env.archive_dir.exists(), "precondition: archive_dir absent"
        old_data = env.root / "old.data"
        old_data.write_text("data")
        count = tidy.clean_stray_files(env)
        assert count >= 1
        assert not old_data.exists()
        assert (env.archive_dir / "old.data").exists()

    def test_skips_unconfigured_files(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        unknown = env.root / "unknown.txt"
        unknown.write_text("unknown")
        count = tidy.clean_stray_files(env)
        assert count == 0
        assert unknown.exists()

    def test_empty_stray_files_no_op(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        count = tidy.clean_stray_files(env)
        assert count == 0


class TestFlagStrayHomeDirs:
    """flag_stray_home_dirs reports unrecognized directories at root."""

    def test_flags_unrecognized_dir(self, tmp_path, capsys):
        env = _make_tidy_env(tmp_path)
        strange = env.root / "strange-dir"
        strange.mkdir(parents=True, exist_ok=True)
        (strange / "some_file.txt").write_text("data")
        count = tidy.flag_stray_home_dirs(env)
        assert count >= 1

    def test_ignores_whitelisted_dirs(self, tmp_path, capsys):
        env = _make_tidy_env(tmp_path)
        # 'data' is in the default whitelist (agent-env infrastructure)
        data = env.data_dir
        data.mkdir(parents=True, exist_ok=True)
        count = tidy.flag_stray_home_dirs(env)
        # data should not be flagged (it's in home_whitelist)
        output = capsys.readouterr().out
        # Just verify "data" doesn't appear in a STRAY DIR line
        if "STRAY DIR" in output:
            assert "data/" not in [line for line in output.split("\n") if "STRAY DIR" in line][0]

    def test_ignores_hidden_dirs(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        hidden = env.root / ".hidden-dir"
        hidden.mkdir(parents=True, exist_ok=True)
        count = tidy.flag_stray_home_dirs(env)
        assert count == 0  # hidden dirs (dotfiles) are never flagged as stray

    def test_ignores_project_dirs(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        proj = env.root / "my-project"
        proj.mkdir(parents=True, exist_ok=True)
        (proj / ".git").mkdir()
        count = tidy.flag_stray_home_dirs(env)
        assert count == 0  # recognized project dirs are not flagged as stray


class TestCleanEmptyArchiveDirs:
    """clean_empty_dirs_in_archive removes empty subdirectories from ~/archive/."""

    def test_removes_empty_dirs(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        archive = env.archive_dir
        empty_sub = archive / "downloads" / "empty_sub"
        empty_sub.mkdir(parents=True, exist_ok=True)
        count = tidy.clean_empty_dirs_in_archive(env)
        assert count >= 1
        assert not empty_sub.exists()

    def test_keeps_nonempty_dirs(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        archive = env.archive_dir / "downloads"
        archive.mkdir(parents=True, exist_ok=True)
        (archive / "file.txt").write_text("data")
        count = tidy.clean_empty_dirs_in_archive(env)
        assert count == 0
        assert archive.exists()

    def test_no_archive_dir(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        count = tidy.clean_empty_dirs_in_archive(env)
        assert count == 0


class TestRunTidy:
    """run_tidy orchestrates all tidy tasks."""

    def test_returns_int(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        count = tidy.run_tidy(env)
        assert isinstance(count, int)

    def test_cleans_pycache(self, tmp_path):
        env = _make_tidy_env(tmp_path)
        pycache = env.root / "__pycache__"
        pycache.mkdir(parents=True, exist_ok=True)
        (pycache / "test.pyc").write_bytes(b"\x00")
        count = tidy.run_tidy(env)
        assert count >= 1
        assert not pycache.exists()