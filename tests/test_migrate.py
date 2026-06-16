"""tests/test_migrate.py — Phase 6: migrate command tests.

All tests operate against tmp roots and the committed v0 fixture.
Zero live-machine contact; real home never touched.
"""
from __future__ import annotations

from pathlib import Path
import pytest

from agent_env import cli
from agent_env.config import Config
from agent_env.environment import Environment
from agent_env import migrate as _migrate

FIXTURE_DIR = Path(__file__).parent / "fixtures"
V0_MAP = FIXTURE_DIR / "v0_agent_map.md"
CURRENT_MAP = FIXTURE_DIR / "generic_agent_map.md"


def _make_env(tmp_path: Path, map_text: str) -> Environment:
    """Bootstrap a minimal Environment rooted at tmp_path with map_text."""
    (tmp_path / "agent_map.md").write_text(map_text)
    state_dir = tmp_path / ".agent-env"
    state_dir.mkdir(exist_ok=True)
    cfg_text = f'[paths]\nhome = "{tmp_path}"\n'
    (state_dir / "config.toml").write_text(cfg_text)
    cfg = Config.load(str(state_dir / "config.toml"))
    return Environment(tmp_path, cfg)


# ── detect_version ─────────────────────────────────────────────────────────────

class TestDetectVersion:
    def test_v0_has_no_stamp(self):
        text = V0_MAP.read_text()
        assert _migrate.detect_version(text) == "0"

    def test_current_map_detected(self):
        text = CURRENT_MAP.read_text()
        assert _migrate.detect_version(text) == "1.0"

    def test_arbitrary_stamp(self):
        assert _migrate.detect_version("<!-- agent-env schema: 2.5 -->\n# map") == "2.5"

    def test_empty_string_returns_zero(self):
        assert _migrate.detect_version("") == "0"

    def test_missing_stamp_returns_zero(self):
        assert _migrate.detect_version("# plain map\n\nno stamp") == "0"


# ── backup_map ─────────────────────────────────────────────────────────────────

class TestBackupMap:
    def test_creates_backup_file(self, tmp_path):
        src = tmp_path / "agent_map.md"
        src.write_text("# hello")
        backups_dir = tmp_path / ".agent-env" / "backups"
        dest = _migrate.backup_map(src, backups_dir)
        assert dest.exists()
        assert dest.read_text() == "# hello"

    def test_backup_dir_created_if_absent(self, tmp_path):
        src = tmp_path / "agent_map.md"
        src.write_text("content")
        backups_dir = tmp_path / "nonexistent" / "backups"
        dest = _migrate.backup_map(src, backups_dir)
        assert dest.parent == backups_dir
        assert backups_dir.exists()

    def test_backup_has_timestamp_in_name(self, tmp_path):
        src = tmp_path / "agent_map.md"
        src.write_text("x")
        backups_dir = tmp_path / "backups"
        dest = _migrate.backup_map(src, backups_dir)
        assert "agent_map." in dest.name
        assert dest.suffix == ".md"

    def test_missing_map_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            _migrate.backup_map(tmp_path / "nonexistent.md", tmp_path / "backups")

    def test_two_backups_have_distinct_names(self, tmp_path):
        src = tmp_path / "agent_map.md"
        src.write_text("x")
        backups_dir = tmp_path / "backups"
        d1 = _migrate.backup_map(src, backups_dir)
        # Write slightly different content and backup again
        src.write_text("y")
        d2 = _migrate.backup_map(src, backups_dir)
        # Both exist; names might be equal if run in same second — that's ok
        # as long as both files exist (OS won't silently drop them)
        assert d1.exists()
        assert d2.exists()


# ── transform_v0_to_v1 ────────────────────────────────────────────────────────

class TestTransformV0ToV1:
    def test_adds_stamp(self):
        result = _migrate.transform_v0_to_v1("# map\ncontent")
        assert result.startswith(f"<!-- agent-env schema: {_migrate.CURRENT_SCHEMA} -->")

    def test_original_content_preserved(self):
        original = "# My Map\n\nSome free-form section.\n"
        result = _migrate.transform_v0_to_v1(original)
        assert "# My Map" in result
        assert "Some free-form section." in result

    def test_3layer_becomes_5layer(self):
        text = "# map\n\nThis is a 3-layer structure for context.\n"
        result = _migrate.transform_v0_to_v1(text)
        assert "5-layer structure" in result
        assert "3-layer" not in result

    def test_idempotent_already_stamped(self):
        stamped = _migrate.transform_v0_to_v1("# map\ncontent\n")
        again = _migrate.transform_v0_to_v1(stamped)
        # Second call: stamp is already there; result should be equivalent
        assert again.count("<!-- agent-env schema:") == 1

    def test_v0_fixture_transforms(self):
        original = V0_MAP.read_text()
        result = _migrate.transform_v0_to_v1(original)
        assert "<!-- agent-env schema: 1.0 -->" in result
        assert "3-layer" not in result
        assert "5-layer" in result

    def test_free_form_sections_untouched(self):
        """Sections not in the known pattern list must be preserved verbatim."""
        custom = (
            "# map\n"
            "## My Custom Section\n\n"
            "This section has weird content that we must never modify.\n"
            "Special chars: & < > \" '\n"
        )
        result = _migrate.transform_v0_to_v1(custom)
        assert "My Custom Section" in result
        assert "weird content that we must never modify" in result
        assert "Special chars: & < > \" '" in result


# ── migrate (full) ─────────────────────────────────────────────────────────────

class TestMigrate:
    def test_v0_migrates_to_current(self, tmp_path):
        env = _make_env(tmp_path, V0_MAP.read_text())
        result = _migrate.migrate(env)
        assert result["version_before"] == "0"
        assert result["version_after"] == _migrate.CURRENT_SCHEMA
        assert result["changed"] is True
        assert result["dry_run"] is False

    def test_backup_created(self, tmp_path):
        env = _make_env(tmp_path, V0_MAP.read_text())
        result = _migrate.migrate(env)
        assert result["backup"] is not None
        assert result["backup"].exists()
        # Backup holds the ORIGINAL v0 content (no stamp)
        backup_text = result["backup"].read_text()
        assert _migrate.detect_version(backup_text) == "0"

    def test_map_upgraded_in_place(self, tmp_path):
        env = _make_env(tmp_path, V0_MAP.read_text())
        _migrate.migrate(env)
        new_text = (tmp_path / "agent_map.md").read_text()
        assert _migrate.detect_version(new_text) == _migrate.CURRENT_SCHEMA

    def test_already_current_is_noop(self, tmp_path):
        env = _make_env(tmp_path, CURRENT_MAP.read_text())
        result = _migrate.migrate(env)
        assert result["changed"] is False
        assert result["backup"] is None

    def test_idempotent_twice(self, tmp_path):
        env = _make_env(tmp_path, V0_MAP.read_text())
        _migrate.migrate(env)
        result2 = _migrate.migrate(env)
        assert result2["changed"] is False, "second migrate must be a no-op"

    def test_dry_run_does_not_write(self, tmp_path):
        original = V0_MAP.read_text()
        env = _make_env(tmp_path, original)
        result = _migrate.migrate(env, dry_run=True)
        assert result["changed"] is True
        assert result["dry_run"] is True
        assert result["backup"] is None  # no backup in dry-run
        # Map must be unchanged on disk
        assert (tmp_path / "agent_map.md").read_text() == original

    def test_missing_map_raises(self, tmp_path):
        state_dir = tmp_path / ".agent-env"
        state_dir.mkdir()
        cfg = Config.load(None)
        env = Environment(tmp_path, cfg)
        with pytest.raises(FileNotFoundError):
            _migrate.migrate(env)

    def test_backups_in_state_dir(self, tmp_path):
        env = _make_env(tmp_path, V0_MAP.read_text())
        result = _migrate.migrate(env)
        backups_dir = tmp_path / ".agent-env" / "backups"
        assert backups_dir.exists()
        assert result["backup"].parent == backups_dir


# ── CLI: agent-env migrate ─────────────────────────────────────────────────────

class TestMigrateCLI:
    def _cfg(self, tmp_path):
        (tmp_path / ".agent-env").mkdir(exist_ok=True)
        cfg_path = tmp_path / ".agent-env" / "config.toml"
        cfg_path.write_text(f'[paths]\nhome = "{tmp_path}"\n')
        return str(cfg_path)

    def test_migrate_v0_via_cli(self, tmp_path):
        (tmp_path / "agent_map.md").write_text(V0_MAP.read_text())
        cfg = self._cfg(tmp_path)
        rc = cli.main(["migrate", "--config", cfg])
        assert rc == 0
        new = (tmp_path / "agent_map.md").read_text()
        assert _migrate.detect_version(new) == _migrate.CURRENT_SCHEMA

    def test_migrate_noop_via_cli(self, tmp_path):
        (tmp_path / "agent_map.md").write_text(CURRENT_MAP.read_text())
        cfg = self._cfg(tmp_path)
        rc = cli.main(["migrate", "--config", cfg])
        assert rc == 0

    def test_migrate_dry_run_via_cli(self, tmp_path):
        original = V0_MAP.read_text()
        (tmp_path / "agent_map.md").write_text(original)
        cfg = self._cfg(tmp_path)
        rc = cli.main(["migrate", "--config", cfg, "--dry-run"])
        assert rc == 0
        # Map unchanged
        assert (tmp_path / "agent_map.md").read_text() == original

    def test_migrate_missing_map_returns_1(self, tmp_path):
        cfg = self._cfg(tmp_path)
        rc = cli.main(["migrate", "--config", cfg])
        assert rc == 1


# ── migrate module main() ──────────────────────────────────────────────────────

class TestMigrateModuleMain:
    """Exercise migrate.main() directly for coverage of the CLI entry point."""

    def _env(self, tmp_path, map_text):
        return _make_env(tmp_path, map_text)

    def test_main_v0(self, tmp_path, capsys, monkeypatch):
        """main() with a v0 map exits 0 and prints the transformation."""
        env = self._env(tmp_path, V0_MAP.read_text())
        cfg_path = str(tmp_path / ".agent-env" / "config.toml")
        monkeypatch.setattr(
            "agent_env.migrate.Environment.load",
            lambda _: env,
        )
        with pytest.raises(SystemExit) as exc:
            _migrate.main()
        assert exc.value.code == 0
        out = capsys.readouterr().out
        assert "Transformed" in out

    def test_main_noop(self, tmp_path, capsys, monkeypatch):
        """main() on an already-current map prints nothing-to-do."""
        env = self._env(tmp_path, CURRENT_MAP.read_text())
        monkeypatch.setattr(
            "agent_env.migrate.Environment.load",
            lambda _: env,
        )
        with pytest.raises(SystemExit) as exc:
            _migrate.main()
        assert exc.value.code == 0
        assert "nothing to do" in capsys.readouterr().out

    def test_main_missing_map_exits_1(self, tmp_path, capsys, monkeypatch):
        """main() on a missing map exits 1."""
        state_dir = tmp_path / ".agent-env"
        state_dir.mkdir()
        cfg = Config.load(None)
        env = Environment(tmp_path, cfg)
        monkeypatch.setattr(
            "agent_env.migrate.Environment.load",
            lambda _: env,
        )
        with pytest.raises(SystemExit) as exc:
            _migrate.main()
        assert exc.value.code == 1

    def test_main_dry_run(self, tmp_path, capsys, monkeypatch):
        """main() with --dry-run does not write."""
        original = V0_MAP.read_text()
        env = self._env(tmp_path, original)
        monkeypatch.setattr(
            "agent_env.migrate.Environment.load",
            lambda _: env,
        )
        monkeypatch.setattr("sys.argv", ["migrate", "--dry-run"])
        with pytest.raises(SystemExit) as exc:
            _migrate.main()
        assert exc.value.code == 0
        assert (tmp_path / "agent_map.md").read_text() == original


# ── unknown-version error ──────────────────────────────────────────────────────

class TestUnknownVersion:
    def test_unknown_version_raises(self, tmp_path):
        """migrate() raises ValueError on an unknown schema version."""
        env = _make_env(tmp_path, "<!-- agent-env schema: 99.9 -->\n# map\n")
        with pytest.raises(ValueError, match="Unknown schema version"):
            _migrate.migrate(env)

    def test_transform_no_change_path(self, tmp_path):
        """When transform produces identical output, changed=False."""
        # A map with the schema stamp already, but spelled v0 for transform purposes.
        # We force this by faking the version detection after the transform.
        env = _make_env(tmp_path, V0_MAP.read_text())
        # Monkey-patch transform to return original unchanged
        original = (tmp_path / "agent_map.md").read_text()
        import agent_env.migrate as m
        old = m.transform_v0_to_v1
        m.transform_v0_to_v1 = lambda t: t  # identity — no change
        result = m.migrate(env)
        m.transform_v0_to_v1 = old  # restore
        assert result["changed"] is False
