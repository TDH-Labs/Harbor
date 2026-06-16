"""Tests for agent_env/environment.py — Environment, path resolution, parse_config_arg."""
from __future__ import annotations

from pathlib import Path

import pytest

from agent_env.config import Config, DEFAULTS
from agent_env.environment import Environment, parse_config_arg

from tests.helpers import make_config, make_env


class TestEnvironmentConstruction:
    """Environment(root, config) basic construction."""

    def test_root_is_set(self, tmp_path):
        env = Environment(tmp_path, Config.defaults())
        assert env.root == tmp_path

    def test_config_is_set(self, tmp_path):
        cfg = Config.defaults()
        env = Environment(tmp_path, cfg)
        assert env.config is cfg

    def test_load_with_defaults(self, tmp_path):
        env = Environment.load(root=tmp_path)
        assert env.root == tmp_path
        assert env.config.home_template == "~"


class TestPathResolution:
    """Environment.resolve() template resolution."""

    def test_tilde_resolves_to_root(self, tmp_path):
        env = make_env(tmp_path)
        assert env.resolve("~") == tmp_path

    def test_tilde_slash_resolves_to_subpath(self, tmp_path):
        env = make_env(tmp_path)
        assert env.resolve("~/.agents/skills") == tmp_path / ".agents" / "skills"

    def test_absolute_path_stays_absolute(self, tmp_path):
        env = make_env(tmp_path)
        assert env.resolve("/absolute/path") == Path("/absolute/path")

    def test_relative_path_joins_to_root(self, tmp_path):
        env = make_env(tmp_path)
        assert env.resolve("relative/path") == tmp_path / "relative" / "path"


class TestStandardPaths:
    """Environment standard derived paths."""

    def test_agent_map(self, tmp_path):
        env = make_env(tmp_path)
        assert env.agent_map == tmp_path / "agent_map.md"

    def test_workspace(self, tmp_path):
        env = make_env(tmp_path)
        assert env.workspace == tmp_path / "workspace"

    def test_rooms(self, tmp_path):
        env = make_env(tmp_path)
        assert env.rooms == tmp_path / "rooms"

    def test_data_dir(self, tmp_path):
        env = make_env(tmp_path)
        assert env.data_dir == tmp_path / "data"

    def test_obsidian(self, tmp_path):
        env = make_env(tmp_path)
        assert env.obsidian == tmp_path / "Obsidian"

    def test_skills_dir(self, tmp_path):
        env = make_env(tmp_path)
        assert env.skills_dir == tmp_path / ".agents" / "skills"

    def test_state_dir(self, tmp_path):
        env = make_env(tmp_path)
        assert env.state_dir == tmp_path / ".agent-env"

    def test_version_file(self, tmp_path):
        env = make_env(tmp_path)
        assert env.version_file == tmp_path / ".agent-env" / "version"

    def test_archive_dir(self, tmp_path):
        env = make_env(tmp_path)
        assert env.archive_dir == tmp_path / "archive"

    def test_downloads_dir(self, tmp_path):
        env = make_env(tmp_path)
        assert env.downloads_dir == tmp_path / "Downloads"


class TestHomeStr:
    """Environment.home_str returns the root as a string for beacon text."""

    def test_home_str_is_string(self, tmp_path):
        env = make_env(tmp_path)
        assert isinstance(env.home_str, str)
        assert env.home_str == str(tmp_path)


class TestWatchPaths:
    """Environment.watch_paths() resolves config watch paths."""

    def test_watch_paths_resolves(self, tmp_path):
        env = make_env(tmp_path)
        paths = env.watch_paths()
        assert len(paths) == 3
        # All should be Path objects under tmp_path
        for p in paths:
            assert isinstance(p, Path)


class TestLoadWithConfigPath:
    """Environment.load() with explicit config path."""

    def test_load_with_config(self, tmp_path):
        cfg_file = tmp_path / "config.toml"
        cfg_file.write_text("""
[paths]
home = "/test/root"

[discovery]
scan_home = false
""")
        env = Environment.load(config_path=cfg_file, root=tmp_path / "explicit")
        assert env.root == tmp_path / "explicit"
        assert env.config.scan_home is False

    def test_load_with_config_object(self, tmp_path):
        cfg = Config.defaults()
        env = Environment.load(config_path=cfg, root=tmp_path)
        assert env.root == tmp_path
        assert env.config.home_template == "~"

    def test_load_derives_root_from_config(self, tmp_path):
        """Environment.load with Config.defaults() uses the given root."""
        env = Environment.load(config_path=Config.defaults(), root=tmp_path)
        assert env.root == tmp_path
        assert env.config.home_template == "~"


class TestParseConfigArg:
    """parse_config_arg extracts --config from argv."""

    def test_no_config_arg(self):
        config_path, remaining = parse_config_arg(["--sync", "--verbose"])
        assert config_path is None
        assert remaining == ["--sync", "--verbose"]

    def test_config_with_equals(self):
        config_path, remaining = parse_config_arg(["--config=/path/to/config.toml", "--sync"])
        assert config_path == "/path/to/config.toml"
        assert remaining == ["--sync"]

    def test_config_with_space(self):
        config_path, remaining = parse_config_arg(["--config", "/path/to/config.toml", "--sync"])
        assert config_path == "/path/to/config.toml"
        assert remaining == ["--sync"]

    def test_config_at_end(self):
        config_path, remaining = parse_config_arg(["--sync", "--config", "my.toml"])
        assert config_path == "my.toml"
        assert remaining == ["--sync"]

    def test_config_missing_path_exits(self):
        with pytest.raises(SystemExit):
            parse_config_arg(["--config"])

    def test_mixed_args(self):
        config_path, remaining = parse_config_arg(["--poll", "--config", "c.toml", "--generate-only"])
        assert config_path == "c.toml"
        assert remaining == ["--poll", "--generate-only"]