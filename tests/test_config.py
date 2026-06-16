"""Tests for agent_env/config.py — Config loading, validation, defaults, merge."""
from __future__ import annotations

import copy
from pathlib import Path

import pytest

from agent_env.config import (
    DEFAULTS,
    Config,
    ConfigError,
    SCHEMA_VERSION,
    _deep_merge,
    _read_toml,
    DEFAULT_CONFIG_PATH,
)


class TestDefaults:
    """Config.defaults() and the DEFAULTS dict."""

    def test_defaults_returns_config(self):
        cfg = Config.defaults()
        assert isinstance(cfg, Config)

    def test_defaults_has_all_top_level_keys(self):
        cfg = Config.defaults()
        for key in ["schema_version", "paths", "discovery", "beacons",
                     "watch", "tidy", "skill_pool", "skills"]:
            assert key in cfg.data

    def test_defaults_paths(self):
        cfg = Config.defaults()
        assert cfg.home_template == "~"
        assert cfg.skills_dir_template == "~/.agents/skills"
        assert cfg.state_dir_template == "~/.agent-env"

    def test_defaults_discovery(self):
        cfg = Config.defaults()
        assert cfg.scan_home is True
        assert isinstance(cfg.skip_dirs, set)
        assert "workspace" in cfg.skip_dirs
        assert isinstance(cfg.project_signatures, list)
        assert ".git" in cfg.project_signatures
        assert isinstance(cfg.skip_list, list)

    def test_defaults_beacons(self):
        cfg = Config.defaults()
        assert "AGENTS.md" in cfg.home_beacon_targets
        assert "CLAUDE.md" in cfg.home_beacon_targets
        assert ".cursorrules" in cfg.home_beacon_targets
        assert cfg.project_beacon == "AGENTS.md"

    def test_defaults_watch(self):
        cfg = Config.defaults()
        assert isinstance(cfg.watch_paths, list)
        assert cfg.watch_cooldown == 10

    def test_defaults_tidy(self):
        cfg = Config.defaults()
        assert cfg.tidy_enabled is False
        assert cfg.downloads_archive_days == 7
        assert isinstance(cfg.home_whitelist, set)
        assert isinstance(cfg.stray_files, dict)
        assert len(cfg.stray_files) == 0

    def test_defaults_skill_pool(self):
        cfg = Config.defaults()
        assert isinstance(cfg.skill_pool_sources, list)
        assert len(cfg.skill_pool_sources) == 0

    def test_defaults_skills(self):
        cfg = Config.defaults()
        assert isinstance(cfg.room_skills, dict)
        assert len(cfg.room_skills) == 0
        assert isinstance(cfg.skill_category_to_room, dict)
        assert len(cfg.skill_category_to_room) == 0

    def test_schema_version_matches(self):
        cfg = Config.defaults()
        assert cfg.schema_version == SCHEMA_VERSION
        assert cfg.schema_version == "1.0"


class TestLoad:
    """Config.load() with various inputs."""

    def test_load_no_args_returns_defaults(self):
        """When no config file exists at the default path, returns defaults."""
        # DEFAULT_CONFIG_PATH likely doesn't exist in test environments
        cfg = Config.load()
        assert isinstance(cfg, Config)
        assert cfg.home_template == "~"

    def test_load_explicit_none_returns_defaults(self):
        """Config.load(None) returns defaults when default path is absent."""
        cfg = Config.load(None)
        assert cfg.home_template == "~"

    def test_load_missing_path_raises(self, tmp_path):
        """Config.load with an explicit missing file raises ConfigError."""
        bad_path = tmp_path / "nonexistent.toml"
        with pytest.raises(ConfigError, match="not found"):
            Config.load(bad_path)

    def test_load_valid_toml(self, tmp_path):
        """Config.load merges a valid TOML file over defaults."""
        cfg_file = tmp_path / "config.toml"
        cfg_file.write_text("""
[paths]
home = "/custom/root"

[discovery]
scan_home = false
""")
        cfg = Config.load(cfg_file)
        assert cfg.home_template == "/custom/root"
        assert cfg.scan_home is False
        # Other defaults should still be present
        assert cfg.watch_cooldown == 10

    def test_load_deep_merge(self, tmp_path):
        """Config.load deep-merges nested dicts."""
        cfg_file = tmp_path / "config.toml"
        cfg_file.write_text("""
[paths]
home = "/test/root"

[discovery]
skip_dirs = ["custom_skip"]
""")
        cfg = Config.load(cfg_file)
        # skip_dirs in TOML replaces the default list (not appends)
        assert "custom_skip" in cfg.skip_dirs
        # workspace should NOT be in the override
        assert "workspace" not in cfg.skip_dirs


class TestDeepMerge:
    """_deep_merge behavior."""

    def test_dict_merges_key_by_key(self):
        base = {"a": 1, "b": {"c": 2, "d": 3}}
        override = {"b": {"c": 99}}
        result = _deep_merge(base, override)
        assert result == {"a": 1, "b": {"c": 99, "d": 3}}

    def test_list_replaces_wholesale(self):
        base = {"items": [1, 2, 3]}
        override = {"items": [4, 5]}
        result = _deep_merge(base, override)
        assert result == {"items": [4, 5]}

    def test_scalar_replaces(self):
        base = {"key": "old"}
        override = {"key": "new"}
        result = _deep_merge(base, override)
        assert result == {"key": "new"}

    def test_unknown_keys_preserved(self):
        base = {"a": 1}
        override = {"b": 2}
        result = _deep_merge(base, override)
        assert result == {"a": 1, "b": 2}

    def test_two_levels_deep(self):
        base = {"l1": {"l2a": {"x": 1, "y": 2}, "l2b": "hello"}}
        override = {"l1": {"l2a": {"x": 99}}}
        result = _deep_merge(base, override)
        assert result == {"l1": {"l2a": {"x": 99, "y": 2}, "l2b": "hello"}}

    def test_does_not_mutate_base(self):
        base = {"a": {"b": 1}}
        override = {"a": {"b": 2}}
        original_base = copy.deepcopy(base)
        _deep_merge(base, override)
        assert base == original_base


class TestValidation:
    """Config._validate() type checks."""

    def test_bad_home_type(self):
        data = copy.deepcopy(DEFAULTS)
        data["paths"]["home"] = 123
        with pytest.raises(ConfigError, match="paths.home must be a string"):
            Config(data)

    def test_bad_skip_dirs_type(self):
        data = copy.deepcopy(DEFAULTS)
        data["discovery"]["skip_dirs"] = "not-a-list"
        with pytest.raises(ConfigError, match="discovery.skip_dirs must be a list"):
            Config(data)

    def test_bad_project_signatures_type(self):
        data = copy.deepcopy(DEFAULTS)
        data["discovery"]["project_signatures"] = "not-a-list"
        with pytest.raises(ConfigError, match="discovery.project_signatures must be a list"):
            Config(data)

    def test_bad_skills_rooms_type(self):
        data = copy.deepcopy(DEFAULTS)
        data["skills"]["rooms"] = "not-a-dict"
        with pytest.raises(ConfigError, match="skills.rooms must be a table"):
            Config(data)

    def test_bad_room_skills_not_list(self):
        data = copy.deepcopy(DEFAULTS)
        data["skills"]["rooms"] = {"research": {"description": "Test", "skills": "not-a-list"}}
        with pytest.raises(ConfigError, match="skills.rooms.research.skills must be a list"):
            Config(data)

    def test_bad_room_skills_missing(self):
        data = copy.deepcopy(DEFAULTS)
        data["skills"]["rooms"] = {"research": {"description": "Test"}}
        with pytest.raises(ConfigError, match="skills.rooms.research must define a skills list"):
            Config(data)


class TestReadToml:
    """_read_toml error handling."""

    def test_invalid_toml_raises_config_error(self, tmp_path):
        bad_toml = tmp_path / "bad.toml"
        bad_toml.write_text("[invalid = toml {{{")
        with pytest.raises(ConfigError, match="invalid TOML"):
            _read_toml(bad_toml)

    def test_valid_toml_parses(self, tmp_path):
        valid_toml = tmp_path / "good.toml"
        valid_toml.write_text('[paths]\nhome = "/test"\n')
        result = _read_toml(valid_toml)
        assert result["paths"]["home"] == "/test"


class TestAccessors:
    """Typed accessors return correct types and values."""

    def test_all_accessors_present(self):
        cfg = Config.defaults()
        # Just verify they don't crash and return expected types
        assert isinstance(cfg.home_template, str)
        assert isinstance(cfg.skills_dir_template, str)
        assert isinstance(cfg.state_dir_template, str)
        assert isinstance(cfg.scan_home, bool)
        assert isinstance(cfg.skip_dirs, set)
        assert isinstance(cfg.project_signatures, list)
        assert isinstance(cfg.skip_list, list)
        assert isinstance(cfg.home_beacon_targets, list)
        assert isinstance(cfg.project_beacon, str)
        assert isinstance(cfg.watch_paths, list)
        assert isinstance(cfg.watch_cooldown, int)
        assert isinstance(cfg.tidy_enabled, bool)
        assert isinstance(cfg.downloads_archive_days, int)
        assert isinstance(cfg.home_whitelist, set)
        assert isinstance(cfg.stray_files, dict)
        assert isinstance(cfg.skill_pool_sources, list)
        assert isinstance(cfg.room_skills, dict)
        assert isinstance(cfg.skill_category_to_room, dict)

    def test_accessors_with_overrides(self, tmp_path):
        cfg_file = tmp_path / "config.toml"
        cfg_file.write_text("""
[paths]
home = "/custom"

[watch]
cooldown_seconds = 30

[tidy]
enabled = true
downloads_archive_days = 14
""")
        cfg = Config.load(cfg_file)
        assert cfg.home_template == "/custom"
        assert cfg.watch_cooldown == 30
        assert cfg.tidy_enabled is True
        assert cfg.downloads_archive_days == 14


class TestConfigFromDict:
    """Config constructed directly from data dict."""

    def test_from_defaults_dict(self):
        data = copy.deepcopy(DEFAULTS)
        cfg = Config(data)
        assert cfg.schema_version == "1.0"
        assert cfg.scan_home is True

    def test_accessor_types_stable(self):
        """Accessors return consistent types across multiple calls."""
        cfg = Config(copy.deepcopy(DEFAULTS))
        assert isinstance(cfg.skip_dirs, set)
        assert isinstance(cfg.home_whitelist, set)
        # Second call should return same types
        assert isinstance(cfg.skip_dirs, set)
        assert isinstance(cfg.home_whitelist, set)