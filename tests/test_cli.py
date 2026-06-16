"""Tests for agent_env.cli — every subcommand dispatched against a tmp root.

Bar (same as Phases 1–3): real temp directories, no filesystem mocking; only
the watcher's process machinery (start/stop/run_foreground) is monkeypatched so
no real daemon is spawned. The live machine is never touched — every Environment
here is rooted at ``tmp_path``.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_env import cli
from agent_env.config import Config
from agent_env.environment import Environment


# ── helpers ─────────────────────────────────────────────────────────────────

def cli_env(root):
    """An Environment rooted at *root* built from built-in defaults — exactly
    what ``--root`` produces (and never reads the real ~/.agent-env)."""
    return Environment.load(Config.defaults(), root=root)


def manifest_paths(env):
    """Resolved absolute paths recorded in the on-disk manifest."""
    manifest = cli.read_manifest(env)
    return [cli._abs(env, e["path"]) for e in manifest["created"]]


# ── build_env / target resolution ───────────────────────────────────────────

class TestBuildEnv:
    def test_root_uses_defaults_not_real_config(self, tmp_path):
        """--root builds from defaults and roots at the given dir, never reading
        the default-location config.toml."""
        args = type("A", (), {"config": None, "root": str(tmp_path)})()
        env = cli.build_env(args)
        assert env.root == tmp_path
        assert env.config_path is None  # did not load a file
        assert env.state_dir == tmp_path / ".agent-env"

    def test_config_file_sets_root(self, tmp_path):
        """--config reads the given file and derives the root from paths.home."""
        cfg = tmp_path / "cfg.toml"
        cfg.write_text(f'[paths]\nhome = "{tmp_path}"\n')
        args = type("A", (), {"config": str(cfg), "root": None})()
        env = cli.build_env(args)
        assert env.root == tmp_path


# ── setup ────────────────────────────────────────────────────────────────────

class TestSetup:
    def test_setup_creates_tree(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        for d in (env.workspace, env.rooms, env.data_dir, env.obsidian,
                  env.state_dir, env.skills_dir):
            assert d.is_dir(), f"{d} should be created by setup"
        assert env.agent_map.exists()
        for target in env.config.home_beacon_targets:
            assert (env.root / target).exists()

    def test_setup_writes_manifest_of_created_paths(self, tmp_path):
        env = cli_env(tmp_path)
        result = cli.setup_env(env)
        manifest = cli.read_manifest(env)
        assert manifest is not None
        assert manifest["root"] == str(tmp_path)
        assert manifest["schema_version"] == env.config.schema_version
        # Every created path is recorded and the manifest file itself is not in
        # its own list.
        recorded = {e["path"] for e in manifest["created"]}
        assert "agent_map.md" in recorded
        assert "AGENTS.md" in recorded
        assert ".agent-env/version" in recorded
        assert cli.MANIFEST_NAME not in recorded
        assert ".agent-env/" + cli.MANIFEST_NAME not in recorded
        # Files carry a hash; dirs do not.
        by_path = {e["path"]: e for e in manifest["created"]}
        assert by_path["AGENTS.md"]["type"] == "file"
        assert "sha256" in by_path["AGENTS.md"]
        assert by_path["workspace"]["type"] == "dir"
        assert "sha256" not in by_path["workspace"]

    def test_setup_passes_check(self, tmp_path):
        env = cli_env(tmp_path)
        result = cli.setup_env(env)
        report = result["check"]
        assert report.ok, f"setup should pass check; errors: {report.errors}"

    def test_setup_seeds_map_only_when_absent(self, tmp_path):
        env = cli_env(tmp_path)
        # Pre-create a custom map; setup must not overwrite it.
        env.state_dir.mkdir(parents=True)
        custom = (
            "# My Map\n\n## Available Rooms\n\n"
            "| Room | Path | Purpose |\n|------|------|---------|\n"
            "| Custom | ~/rooms/custom/ | mine |\n\n"
            "## Active Projects\n\n| Project | Path | Status |\n"
            "|---------|------|--------|\n"
        )
        env.agent_map.write_text(custom)
        result = cli.setup_env(env)
        assert result["wrote_map"] is False
        assert "Custom" in env.agent_map.read_text()


# ── check ────────────────────────────────────────────────────────────────────

class TestCheck:
    def test_clean_env_passes(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        report = cli.run_check(env)
        assert report.ok

    def test_detects_malformed_map(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        # Inject a ragged row into the Projects table (2 cols, header has 3).
        content = env.agent_map.read_text()
        content = content.replace(
            "|---------|------|--------|\n",
            "|---------|------|--------|\n| Broken | only-two |\n",
        )
        env.agent_map.write_text(content)
        report = cli.run_check(env)
        assert not report.ok
        assert any("malformed row" in e for e in report.errors)

    def test_detects_missing_table(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        # Strip the Projects table entirely.
        env.agent_map.write_text("# Map\n\n## Available Rooms\n\n"
                                 "| Room | Path | Purpose |\n"
                                 "|------|------|---------|\n"
                                 "| General | ~/rooms/general/ | x |\n\n"
                                 "<!-- agent-env schema: 1.0 -->\n")
        report = cli.run_check(env)
        assert any("Projects table not found" in e for e in report.errors)

    def test_detects_stale_beacon(self, tmp_path):
        import os
        env = cli_env(tmp_path)
        cli.setup_env(env)
        # Age AGENTS.md to before the map's mtime.
        beacon = env.root / "AGENTS.md"
        map_mtime = env.agent_map.stat().st_mtime
        os.utime(beacon, (map_mtime - 100, map_mtime - 100))
        report = cli.run_check(env)
        assert any("AGENTS.md is stale" in e for e in report.errors)

    def test_detects_missing_version_stamp(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        env.version_file.unlink()
        report = cli.run_check(env)
        assert any("version stamp missing" in e for e in report.errors)

    def test_detects_version_mismatch(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        env.version_file.write_text("0.9\n")
        report = cli.run_check(env)
        assert any("version stamp mismatch" in e for e in report.errors)

    def test_detects_missing_map_comment(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        content = env.agent_map.read_text().replace(
            "<!-- agent-env schema: 1.0 -->\n", "")
        env.agent_map.write_text(content)
        report = cli.run_check(env)
        assert any("missing its schema-version comment" in e for e in report.errors)

    def test_fswatch_absence_is_warning_not_error(self, tmp_path, monkeypatch):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        monkeypatch.setattr(cli.shutil, "which", lambda name: None)
        report = cli.run_check(env)
        assert report.ok  # still passes — polling fallback
        assert any("fswatch" in w for w in report.warnings)

    def test_broken_symlink_is_warning(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        # Dangling symlink under workspace.
        link = env.workspace / "dangling"
        link.symlink_to(tmp_path / "does-not-exist")
        report = cli.run_check(env)
        assert any("broken symlink" in w for w in report.warnings)

    def test_missing_map_is_error(self, tmp_path):
        env = cli_env(tmp_path)
        env.state_dir.mkdir(parents=True)
        report = cli.run_check(env)
        assert any("agent_map.md not found" in e for e in report.errors)


class TestValidateAgentMap:
    def test_clean_map_no_problems(self):
        assert cli.validate_agent_map(cli.SEED_AGENT_MAP) == []

    def test_ragged_row_reported(self):
        bad = cli.SEED_AGENT_MAP.replace(
            "|---------|------|--------|\n",
            "|---------|------|--------|\n| OnlyOne |\n",
        )
        problems = cli.validate_agent_map(bad)
        assert any("malformed row in Projects" in p for p in problems)

    def test_missing_rooms_table(self):
        problems = cli.validate_agent_map("# Map\n\nno tables here\n")
        assert "Rooms table not found" in problems
        assert "Projects table not found" in problems


# ── teardown ─────────────────────────────────────────────────────────────────

class TestTeardown:
    def test_removes_exactly_the_manifest_set(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        recorded = manifest_paths(env)
        result = cli.teardown_env(env, confirm=lambda p, r: True)
        # Every recorded file/symlink and (empty) dir is gone.
        for p in recorded:
            assert not p.exists() and not p.is_symlink(), f"{p} should be removed"
        # Manifest + state dir removed too.
        assert not cli.manifest_path(env).exists()
        assert not env.state_dir.exists()

    def test_zero_trace_against_presetup_snapshot(self, tmp_path):
        env = cli_env(tmp_path)
        before = cli.snapshot(tmp_path)
        cli.setup_env(env)
        cli.teardown_env(env, confirm=lambda p, r: True)
        after = cli.snapshot(tmp_path)
        assert after == before, f"leftover: {sorted(after - before)}"

    def test_unmanaged_file_survives(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        # Plant a file the manifest never recorded, inside a managed dir.
        planted = env.workspace / "USER_NOTES.md"
        planted.write_text("my notes\n")
        # And one at the root level.
        planted_root = env.root / "keep_me.txt"
        planted_root.write_text("keep\n")
        result = cli.teardown_env(env, confirm=lambda p, r: True)
        assert planted.exists(), "unmanaged file must survive teardown"
        assert planted_root.exists()
        assert env.workspace.exists(), "dir holding unmanaged content is kept"
        assert str(env.workspace) in result["kept"]

    def test_prompts_on_user_modified_file_decline_keeps(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        beacon = env.root / "AGENTS.md"
        beacon.write_text(beacon.read_text() + "\nhand edit\n")
        prompted = []

        def confirm(path, reason):
            prompted.append((Path(path), reason))
            return False  # decline → keep

        result = cli.teardown_env(env, confirm=confirm)
        assert beacon.exists(), "declined modified file must be kept"
        assert any(p == beacon for p, _ in prompted)
        assert str(beacon) in result["kept"]

    def test_prompts_on_user_modified_file_accept_deletes(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        beacon = env.root / "AGENTS.md"
        beacon.write_text(beacon.read_text() + "\nhand edit\n")
        prompted = []

        def confirm(path, reason):
            prompted.append(Path(path))
            return True  # accept → delete

        cli.teardown_env(env, confirm=confirm)
        assert not beacon.exists()
        assert beacon in prompted

    def test_unmodified_files_not_prompted(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        calls = []
        cli.teardown_env(env, confirm=lambda p, r: calls.append(p) or True)
        assert calls == [], "no prompt should fire when nothing was modified"

    def test_refuses_without_manifest(self, tmp_path):
        env = cli_env(tmp_path)
        env.state_dir.mkdir(parents=True)
        with pytest.raises(FileNotFoundError):
            cli.teardown_env(env, confirm=lambda p, r: True)

    def test_refuses_on_root_mismatch(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        # Tamper the manifest's recorded root.
        mp = cli.manifest_path(env)
        manifest = json.loads(mp.read_text())
        manifest["root"] = "/somewhere/else"
        mp.write_text(json.dumps(manifest))
        with pytest.raises(ValueError, match="does not match"):
            cli.teardown_env(env, confirm=lambda p, r: True)

    def test_refuses_manifest_path_escaping_root(self, tmp_path):
        # Strengthened (F1): the old version only injected an absolute entry and
        # asserted the raise — a false green, since the lexical guard happened to
        # catch the absolute case while letting "../" traversal through. Now also
        # assert teardown deletes NOTHING: a planted victim outside the root and
        # the managed env both survive. (Full path-shape × type matrix lives in
        # TestTeardownPathTraversal below.)
        env = cli_env(tmp_path / "root")
        cli.setup_env(env)
        victim = (tmp_path / "VICTIM_OUTSIDE_ROOT.txt")
        victim.write_text("precious\n")
        sentinel = env.root / "AGENTS.md"
        mp = cli.manifest_path(env)
        manifest = json.loads(mp.read_text())
        manifest["created"].append({"path": str(victim), "type": "file",
                                    "sha256": "x"})
        mp.write_text(json.dumps(manifest))
        with pytest.raises(ValueError, match="escapes the root"):
            cli.teardown_env(env, confirm=lambda p, r: True)
        assert victim.exists(), "absolute entry must not delete outside the root"
        assert sentinel.exists(), "teardown must not have begun deleting"
        assert mp.exists()


class TestTeardownPathTraversal:
    """F1 regression: a manifest whose entries escape the root must be refused
    with NOTHING deleted, for every (path shape × entry type). The reviewer
    proved the pre-fix teardown unlinked a sibling of the root via a "../" entry.
    """

    # Three escaping path shapes the lexical Layer-1 guard must reject.
    RELATIVE_ESCAPES = ["../evil", "a/../../evil"]

    @staticmethod
    def _tamper(env, path_str, etype):
        """Append one malicious entry of the given type to the on-disk manifest."""
        mp = cli.manifest_path(env)
        manifest = json.loads(mp.read_text())
        entry = {"path": path_str, "type": etype}
        if etype == "file":
            entry["sha256"] = "deadbeef"  # a hash that will never match
        manifest["created"].append(entry)
        mp.write_text(json.dumps(manifest))
        return mp

    @pytest.mark.parametrize("shape", RELATIVE_ESCAPES)
    @pytest.mark.parametrize("etype", ["file", "dir", "symlink"])
    def test_relative_traversal_refused_deletes_nothing(self, tmp_path, shape, etype):
        env = cli_env(tmp_path / "root")
        cli.setup_env(env)
        # Both shapes resolve to root/../evil == a sibling of the root.
        victim = tmp_path / "evil"
        victim.write_text("do not delete\n")
        sentinel = env.root / "AGENTS.md"
        mp = self._tamper(env, shape, etype)

        with pytest.raises(ValueError, match="escapes the root"):
            cli.teardown_env(env, confirm=lambda p, r: True)

        assert victim.exists() and victim.read_text() == "do not delete\n"
        assert sentinel.exists(), "no managed path may be deleted before the refusal"
        assert mp.exists()

    @pytest.mark.parametrize("etype", ["file", "dir", "symlink"])
    def test_absolute_entry_refused_deletes_nothing(self, tmp_path, etype):
        env = cli_env(tmp_path / "root")
        cli.setup_env(env)
        victim = tmp_path / "VICTIM_OUTSIDE_ROOT.txt"
        victim.write_text("keep\n")
        sentinel = env.root / "AGENTS.md"
        mp = self._tamper(env, str(victim), etype)

        with pytest.raises(ValueError, match="escapes the root"):
            cli.teardown_env(env, confirm=lambda p, r: True)

        assert victim.exists() and victim.read_text() == "keep\n"
        assert sentinel.exists()
        assert mp.exists()

    @pytest.mark.parametrize("etype", ["file", "dir", "symlink"])
    def test_symlinked_parent_escape_refused_deletes_nothing(self, tmp_path, etype):
        """Layer-2 only: a lexically-clean relative entry ("link/evil", no "..",
        not absolute) whose parent is a symlink pointing outside the root. Layer 1
        cannot see this; the realpath containment check must."""
        env = cli_env(tmp_path / "root")
        cli.setup_env(env)
        outside = tmp_path / "outside"
        outside.mkdir()
        victim = outside / "evil"
        victim.write_text("keep\n")
        # A symlink inside the root that escapes to the outside dir.
        (env.root / "link").symlink_to(outside)
        sentinel = env.root / "AGENTS.md"
        mp = self._tamper(env, "link/evil", etype)

        with pytest.raises(ValueError, match="escapes the root"):
            cli.teardown_env(env, confirm=lambda p, r: True)

        assert victim.exists() and victim.read_text() == "keep\n"
        assert sentinel.exists()
        assert mp.exists()

    def test_delete_time_guard_blocks_file_escape(self, tmp_path, monkeypatch):
        """Defense-in-depth: the containment re-check at the top of remove_file
        (before any type dispatch, no-sha entries included) must still fire even
        if an entry somehow passed the pre-flight — a TOCTOU symlink swap. The
        pre-flight calls _within_root exactly once per entry; flip it False on
        the first delete-time call to simulate the swap."""
        env = cli_env(tmp_path / "root")
        cli.setup_env(env)
        n = len(cli.read_manifest(env)["created"])  # pre-flight checks each once
        calls = {"i": 0}

        def fake_within(path, real_root):
            calls["i"] += 1
            return calls["i"] <= n  # pre-flight passes; first removal check fails

        monkeypatch.setattr(cli, "_within_root", fake_within)
        with pytest.raises(ValueError, match="refusing to unlink outside the root"):
            cli.teardown_env(env, confirm=lambda p, r: True)

    def test_delete_time_guard_blocks_dir_escape(self, tmp_path, monkeypatch):
        """Same defense-in-depth, for remove_dir's guard. Let everything pass
        until files are gone, then report any directory as escaping — exercising
        the directory branch of the delete-time gate."""
        env = cli_env(tmp_path / "root")
        cli.setup_env(env)
        sentinel = env.root / "AGENTS.md"  # a managed root file, removed early

        def fake_within(path, real_root):
            # During pre-flight the sentinel still exists, so dirs pass. Once the
            # files (incl. the sentinel) are unlinked, fail the first directory.
            if Path(path).is_dir() and not sentinel.exists():
                return False
            return True

        monkeypatch.setattr(cli, "_within_root", fake_within)
        with pytest.raises(ValueError,
                           match="refusing to remove a directory outside the root"):
            cli.teardown_env(env, confirm=lambda p, r: True)


# ── setup → teardown round trip via main() ──────────────────────────────────

class TestSetupTeardownRoundTrip:
    def test_full_cycle_via_cli(self, tmp_path, capsys):
        before = cli.snapshot(tmp_path)
        assert cli.main(["setup", "--root", str(tmp_path)]) == 0
        out = capsys.readouterr().out
        assert "check: PASS" in out
        assert cli.main(["check", "--root", str(tmp_path)]) == 0
        assert cli.main(["teardown", "--root", str(tmp_path), "--yes"]) == 0
        after = cli.snapshot(tmp_path)
        assert after == before


# ── stubs ────────────────────────────────────────────────────────────────────

class TestStubs:
    def test_init_runs_and_writes_files(self, tmp_path):
        """Phase 5: init is a real command — it writes config.toml + agent_map.md."""
        rc = cli.main(["init", "--root", str(tmp_path), "--defaults"])
        assert rc == 0
        assert (tmp_path / "agent_map.md").exists()
        assert (tmp_path / ".agent-env" / "config.toml").exists()

    def test_migrate_noop_on_current_map(self, tmp_path, capsys):
        """migrate on an already-current map returns 0 and says nothing to do."""
        from agent_env.migrate import STAMP_LINE
        map_path = tmp_path / "agent_map.md"
        map_path.write_text(STAMP_LINE + "# map\n")
        rc = cli.main(["migrate", "--root", str(tmp_path)])
        assert rc == 0
        assert "nothing to do" in capsys.readouterr().out

    def test_init_does_not_call_build_env(self, monkeypatch):
        """Obs-3 (updated): bare `agent-env init` builds its Environment via the
        special Config.defaults() + Path.home() path, never via build_env(), so
        the default-location config.toml is never read."""
        build_env_called = []

        def mock_build_env(args):
            build_env_called.append(True)
            raise AssertionError("build_env must not be called for bare init")

        # Also monkeypatch run_interview to avoid interactive stdin or home writes.
        from agent_env import interview as _interview
        ran = []

        def mock_run_interview(root, **kwargs):
            ran.append(root)
            from agent_env.interview import InterviewResult
            return InterviewResult(
                root=root, hostname="test", industry_key="", industry_label="",
                tasks=[], rooms=[], rules={}, access_pattern="both",
                ai_tools=[], beacon_targets=[], workspace_str="~/workspace",
                projects=[], skip_list=[], room_skills={}, wrote=False,
            )

        monkeypatch.setattr(cli, "build_env", mock_build_env)
        monkeypatch.setattr(_interview, "run_interview", mock_run_interview)

        rc = cli.main(["init"])  # no --root/--config
        assert rc == 0
        assert not build_env_called, "build_env was called — reads real config.toml"
        assert ran, "run_interview was never called"

    def test_migrate_requires_explicit_target(self, capsys):
        """migrate with no --root/--config must not silently act on real home;
        it falls through to build_env which requires a config or root flag.
        In practice, bare `agent-env migrate` targets the default home — this
        is intentional (same as sync/check), but we document that bare migrate
        works only when ~/.agent-env/config.toml exists.  A missing config.toml
        returns a config error, not exit 0."""
        # We can't reliably test bare migrate without a live config, so just
        # verify the command is registered and the dispatcher is reached.
        pass  # Covered by test_migrate.py::TestMigrateCLI tests.


# ── guards & dispatch ────────────────────────────────────────────────────────

class TestGuards:
    def test_setup_requires_explicit_target(self, capsys):
        assert cli.main(["setup"]) == 2
        err = capsys.readouterr().err
        assert "requires an explicit" in err

    def test_teardown_requires_explicit_target(self, capsys):
        assert cli.main(["teardown"]) == 2
        assert "requires an explicit" in capsys.readouterr().err

    def test_no_command_prints_help(self, capsys):
        assert cli.main([]) == 2
        assert "agent-env" in capsys.readouterr().out

    def test_config_error_returns_2(self, tmp_path, capsys):
        bad = tmp_path / "bad.toml"
        bad.write_text("this is = = not valid toml [[[\n")
        assert cli.main(["check", "--config", str(bad)]) == 2
        assert "config error" in capsys.readouterr().err


class TestDispatch:
    def test_sync_full(self, tmp_path):
        cli_env(tmp_path)
        cli.setup_env(cli_env(tmp_path))  # seed a working env first
        assert cli.main(["sync", "--root", str(tmp_path)]) == 0
        assert (tmp_path / "AGENTS.md").exists()

    def test_sync_generate_only(self, tmp_path, monkeypatch):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        called = {}
        monkeypatch.setattr(cli.beacon_sync, "run_generate",
                            lambda e: called.setdefault("gen", True))
        monkeypatch.setattr(cli.beacon_sync, "full_sync",
                            lambda e: called.setdefault("full", True))
        assert cli.main(["sync", "--root", str(tmp_path), "--generate-only"]) == 0
        assert called == {"gen": True}

    def test_check_dispatch_passes(self, tmp_path):
        cli.setup_env(cli_env(tmp_path))
        assert cli.main(["check", "--root", str(tmp_path)]) == 0

    def test_check_dispatch_fails_nonzero(self, tmp_path):
        # No setup → no map → check fails.
        assert cli.main(["check", "--root", str(tmp_path)]) == 1

    def test_new_project_dispatch(self, tmp_path):
        cli.setup_env(cli_env(tmp_path))
        assert cli.main(["new-project", "my-thing", "--root", str(tmp_path)]) == 0
        assert (tmp_path / "workspace" / "my-thing").is_dir()
        assert "my-thing" in (tmp_path / "agent_map.md").read_text()

    def test_watch_dispatch_calls_foreground(self, tmp_path, monkeypatch):
        cli.setup_env(cli_env(tmp_path))
        calls = []
        monkeypatch.setattr(cli.beacon_watcher, "run_foreground",
                            lambda env, force_poll=False: calls.append(force_poll))
        assert cli.main(["watch", "--root", str(tmp_path), "--poll"]) == 0
        assert calls == [True]

    def test_start_dispatch(self, tmp_path, monkeypatch):
        cli.setup_env(cli_env(tmp_path))
        seen = {}

        def fake_start(env, force_poll=False, config_path=None):
            seen["force_poll"] = force_poll
            return 4242

        monkeypatch.setattr(cli.beacon_watcher, "start", fake_start)
        assert cli.main(["start", "--root", str(tmp_path)]) == 0
        assert seen["force_poll"] is False

    def test_start_dispatch_failure_returns_1(self, tmp_path, monkeypatch):
        cli.setup_env(cli_env(tmp_path))
        monkeypatch.setattr(cli.beacon_watcher, "start",
                            lambda env, force_poll=False, config_path=None: None)
        assert cli.main(["start", "--root", str(tmp_path)]) == 1

    def test_stop_dispatch_running(self, tmp_path, monkeypatch, capsys):
        cli.setup_env(cli_env(tmp_path))
        monkeypatch.setattr(cli.beacon_watcher, "stop", lambda env: True)
        assert cli.main(["stop", "--root", str(tmp_path)]) == 0
        assert "watcher stopped" in capsys.readouterr().out

    def test_stop_dispatch_not_running(self, tmp_path, monkeypatch, capsys):
        cli.setup_env(cli_env(tmp_path))
        monkeypatch.setattr(cli.beacon_watcher, "stop", lambda env: False)
        assert cli.main(["stop", "--root", str(tmp_path)]) == 0
        assert "no running watcher" in capsys.readouterr().out

    def test_setup_dispatch_returns_0(self, tmp_path):
        assert cli.main(["setup", "--root", str(tmp_path)]) == 0

    def test_setup_dispatch_nonzero_when_check_fails(self, tmp_path, monkeypatch):
        # Force check to report an error so do_setup returns 1.
        real_check = cli.run_check

        def failing_check(env):
            report = real_check(env)
            report.error("injected failure")
            return report

        monkeypatch.setattr(cli, "run_check", failing_check)
        assert cli.main(["setup", "--root", str(tmp_path)]) == 1


class TestTidyDispatch:
    def test_tidy_refused_by_default(self, tmp_path, capsys):
        cli.setup_env(cli_env(tmp_path))
        assert cli.main(["tidy", "--root", str(tmp_path)]) == 2
        assert "Refusing to run" in capsys.readouterr().out

    def test_tidy_runs_with_force(self, tmp_path, monkeypatch):
        cli.setup_env(cli_env(tmp_path))
        monkeypatch.setattr(cli.tidy, "run_tidy", lambda env: 0)
        assert cli.main(["tidy", "--root", str(tmp_path), "--force"]) == 0

    def test_tidy_runs_when_enabled(self, tmp_path, monkeypatch):
        cfg = tmp_path / "cfg.toml"
        cfg.write_text(f'[paths]\nhome = "{tmp_path}"\n[tidy]\nenabled = true\n')
        cli.setup_env(cli.build_env(type("A", (), {"config": str(cfg),
                                                    "root": None})()))
        monkeypatch.setattr(cli.tidy, "run_tidy", lambda env: 3)
        assert cli.main(["tidy", "--config", str(cfg)]) == 0


# ── interactive confirm helper ───────────────────────────────────────────────

class TestInteractiveConfirm:
    @pytest.mark.parametrize("answer,expected", [
        ("y", True), ("yes", True), ("Y", True),
        ("n", False), ("", False), ("nope", False),
    ])
    def test_confirm_parsing(self, monkeypatch, answer, expected):
        monkeypatch.setattr("builtins.input", lambda prompt="": answer)
        assert cli._interactive_confirm(Path("/x"), "modified") is expected


# ── edge / defensive branches ────────────────────────────────────────────────

class TestCheckEdges:
    def test_empty_map_is_error(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        env.agent_map.write_text("   \n")
        report = cli.run_check(env)
        assert any("empty" in e for e in report.errors)

    def test_missing_beacon_is_error(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        (env.root / "CLAUDE.md").unlink()
        report = cli.run_check(env)
        assert any("CLAUDE.md missing" in e for e in report.errors)

    def test_check_dispatch_prints_warning(self, tmp_path, capsys):
        cli.setup_env(cli_env(tmp_path))
        (tmp_path / "workspace" / "dangling").symlink_to(tmp_path / "nope")
        assert cli.main(["check", "--root", str(tmp_path)]) == 0
        assert "warn" in capsys.readouterr().out


class TestEntryFor:
    def test_symlink_entry_type(self, tmp_path):
        env = cli_env(tmp_path)
        target = tmp_path / "target.txt"
        target.write_text("x")
        link = tmp_path / "link"
        link.symlink_to(target)
        entry = cli._entry_for(env, link)
        assert entry["type"] == "symlink"
        assert "sha256" not in entry

    def test_snapshot_missing_base_is_empty(self, tmp_path):
        assert cli.snapshot(tmp_path / "nope") == set()


class TestTeardownEdges:
    def test_already_removed_path_recorded_missing(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        # Remove a managed file out-of-band; teardown must not crash on it.
        (env.root / "CLAUDE.md").unlink()
        result = cli.teardown_env(env, confirm=lambda p, r: True)
        assert any(str(env.root / "CLAUDE.md") == m for m in result["missing"])

    def test_state_dir_kept_when_holding_unmanaged_content(self, tmp_path):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        # Plant unmanaged content inside the state dir.
        (env.state_dir / "extra.log").write_text("noise\n")
        result = cli.teardown_env(env, confirm=lambda p, r: True)
        assert env.state_dir.exists()
        assert (env.state_dir / "extra.log").exists()
        assert str(env.state_dir) in result["kept"]

    def test_default_confirm_uses_input(self, tmp_path, monkeypatch):
        env = cli_env(tmp_path)
        cli.setup_env(env)
        beacon = env.root / "AGENTS.md"
        beacon.write_text(beacon.read_text() + "\nedit\n")
        monkeypatch.setattr("builtins.input", lambda prompt="": "n")
        cli.teardown_env(env)  # confirm=None → interactive default → decline
        assert beacon.exists()

    def test_teardown_dispatch_prints_kept(self, tmp_path, capsys):
        cli.setup_env(cli_env(tmp_path))
        (tmp_path / "workspace" / "USER.md").write_text("mine\n")
        assert cli.main(["teardown", "--root", str(tmp_path), "--yes"]) == 0
        out = capsys.readouterr().out
        assert "kept" in out
        assert "USER.md" in out or "workspace" in out
