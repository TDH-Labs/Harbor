"""tests/test_interview.py — Phase 5a interview tests.

Bar (same as prior phases):
* Real temp directories, no filesystem mocking.
* Non-interactive path (pre-filled answers or --defaults) for all question flows.
* Zero live-machine contact: every Environment rooted at tmp_path.
* No personal strings in fixtures.

All tests that interact with the filesystem use tmp_path; none touch the real
$HOME, ~/.agent-env/, ~/agent_map.md, ~/workspace, or any real directory.
"""
from __future__ import annotations

import json
import os
import socket
from pathlib import Path

import pytest

from agent_env import cli, interview
from agent_env.config import Config
from agent_env.environment import Environment
from agent_env.interview import (
    INDUSTRIES,
    INDUSTRY_TASKS,
    TASK_TO_ROOM,
    ROOM_CONSTRAINTS,
    ROOM_PURPOSE,
    AI_TOOLS,
    ACCESS_PATTERNS,
    InterviewResult,
    DictIO,
    get_constraint,
    tasks_to_rooms,
    run_interview,
    _scan_candidates,
    _build_agent_map,
    _build_config_toml,
    _toml_str_list,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def minimal_pre():
    """A minimal pre-answers dict that covers all questions without prompting."""
    return {
        "industry": "software",
        "tasks": ["code_review", "documentation"],
        "access_pattern": "agent",
        "ai_tools": ["claude_code", "agents_md"],
        "consolidate": [],
        "confirm_write": True,
    }


@pytest.fixture
def legal_pre():
    return {
        "industry": "legal",
        "tasks": ["document_review", "legal_research", "drafting"],
        "access_pattern": "human",
        "ai_tools": ["agents_md"],
        "consolidate": [],
        "confirm_write": True,
    }


def _run(tmp_path, pre, sync=False):
    """Run the interview against a tmp root; sync=False for speed in most tests."""
    return run_interview(tmp_path, pre=pre, confirm_map=False, sync=sync)


# ── Isolation guard ───────────────────────────────────────────────────────────

class TestIsolationGuard:
    """Assert that the interview never reads or writes the real $HOME."""

    def test_root_is_not_home(self, tmp_path, minimal_pre):
        result = _run(tmp_path, minimal_pre)
        assert result.root != Path.home(), (
            "interview.run_interview operated on real $HOME — isolation violated"
        )

    def test_config_written_under_tmp(self, tmp_path, minimal_pre):
        pre = dict(minimal_pre, confirm_write=True)
        _run(tmp_path, pre)
        cfg = tmp_path / ".agent-env" / "config.toml"
        assert cfg.exists(), "config.toml not written"
        assert str(tmp_path) in cfg.read_text(), "config.toml references wrong root"

    def test_map_written_under_tmp(self, tmp_path, minimal_pre):
        pre = dict(minimal_pre, confirm_write=True)
        _run(tmp_path, pre)
        mp = tmp_path / "agent_map.md"
        assert mp.exists(), "agent_map.md not written"
        assert str(tmp_path) in mp.read_text(), "agent_map.md references wrong root"


# ── Data table consistency ───────────────────────────────────────────────────

class TestDataTables:
    def test_all_industry_keys_have_tasks(self):
        ind_keys = {k for k, _ in INDUSTRIES}
        for key in ind_keys:
            if key == "other":
                continue
            assert key in INDUSTRY_TASKS, f"No tasks for industry '{key}'"

    def test_all_task_keys_have_room_mapping(self):
        for ind_key, tasks in INDUSTRY_TASKS.items():
            for task_key, _ in tasks:
                assert task_key in TASK_TO_ROOM, (
                    f"Task '{task_key}' (industry={ind_key}) has no room mapping"
                )

    def test_all_rooms_have_purpose(self):
        all_rooms = set(TASK_TO_ROOM.values())
        for room in all_rooms:
            assert room in ROOM_PURPOSE, f"Room '{room}' has no purpose label"

    def test_generic_constraint_fallback_for_all_rooms(self):
        all_rooms = set(TASK_TO_ROOM.values())
        for room in all_rooms:
            # Should not raise; should return a non-empty string
            c = get_constraint("software", room)
            assert isinstance(c, str) and c


# ── Q1: Industry ────────────────────────────────────────────────────────────

class TestQ1Industry:
    def test_known_industry_key(self, tmp_path):
        result = _run(tmp_path, {"industry": "legal", "confirm_write": True,
                                  "tasks": ["document_review"], "access_pattern": "human",
                                  "ai_tools": ["agents_md"], "consolidate": []})
        assert result.industry_key == "legal"
        assert result.industry_label == "Legal"

    def test_custom_industry(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "other",
            "industry_label": "Sustainable Agriculture",
            "tasks": ["research"],
            "access_pattern": "both",
            "ai_tools": ["agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.industry_key == "other"
        assert result.industry_label == "Sustainable Agriculture"

    def test_unknown_key_falls_back_to_other(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "unknown_xyz",
            "tasks": ["research"],
            "access_pattern": "both",
            "ai_tools": ["agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.industry_key == "other"


# ── Q2: Tasks → rooms ────────────────────────────────────────────────────────

class TestQ2Tasks:
    def test_tasks_produce_correct_rooms(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review", "documentation"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert "dev" in result.rooms
        assert "docs" in result.rooms

    def test_shared_room_deduplicated(self, tmp_path):
        # code_review and debugging both map to "dev"
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review", "debugging", "testing"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.rooms.count("dev") == 1, "Room 'dev' should appear only once"

    def test_empty_task_list_gets_fallback(self, tmp_path):
        # Pre-answers with empty tasks → falls back to first task in options
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": [],
            "access_pattern": "both",
            "ai_tools": ["agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert len(result.rooms) >= 1

    def test_legal_tasks_produce_expected_rooms(self, tmp_path, legal_pre):
        result = _run(tmp_path, legal_pre)
        assert "review" in result.rooms
        assert "research" in result.rooms
        assert "drafting" in result.rooms

    @pytest.mark.parametrize("industry,task,expected_room", [
        ("software",   "code_review",    "dev"),
        ("software",   "documentation",  "docs"),
        ("legal",      "compliance",     "compliance"),
        ("accounting", "reconciliation", "accounting"),
        ("marketing",  "content",        "content"),
    ])
    def test_task_to_room_mapping(self, tmp_path, industry, task, expected_room):
        result = _run(tmp_path, {
            "industry": industry,
            "tasks": [task],
            "access_pattern": "both",
            "ai_tools": ["agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert expected_room in result.rooms


# ── Q3: Constraints (rules) ──────────────────────────────────────────────────

class TestQ3Rules:
    def test_derived_constraints_come_from_table(self, tmp_path):
        """Constraints come from ROOM_CONSTRAINTS, not invented per-run."""
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        expected = ROOM_CONSTRAINTS[("software", "dev")]
        assert result.rules["dev"] == expected

    def test_pre_rule_overrides_default(self, tmp_path):
        custom_rule = "Custom rule: no AI-generated code without review."
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "rules": {"dev": custom_rule},
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.rules["dev"] == custom_rule

    @pytest.mark.parametrize("industry,room_key", [
        ("legal",      "review"),
        ("accounting", "reporting"),
        ("research",   "research"),
        ("healthcare", "review"),
        ("marketing",  "content"),
    ])
    def test_industry_specific_constraint(self, tmp_path, industry, room_key):
        task = next(
            k for k, _ in INDUSTRY_TASKS.get(industry, INDUSTRY_TASKS["other"])
            if TASK_TO_ROOM.get(k) == room_key
        )
        result = _run(tmp_path, {
            "industry": industry,
            "tasks": [task],
            "access_pattern": "both",
            "ai_tools": ["agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        expected = ROOM_CONSTRAINTS.get(
            (industry, room_key),
            ROOM_CONSTRAINTS.get((None, room_key), "")
        )
        assert result.rules[room_key] == expected

    def test_map_contains_room_rules(self, tmp_path):
        """agent_map.md produced by init contains the derived constraint text."""
        result = _run(tmp_path, {
            "industry": "legal",
            "tasks": ["compliance"],
            "access_pattern": "human",
            "ai_tools": ["agents_md"],
            "confirm_write": True,
            "consolidate": [],
        })
        map_text = (tmp_path / "agent_map.md").read_text()
        constraint = result.rules["compliance"]
        assert constraint in map_text


# ── Q4: Access pattern ───────────────────────────────────────────────────────

class TestQ4AccessPattern:
    @pytest.mark.parametrize("pattern", ["agent", "human", "both"])
    def test_access_pattern_persisted(self, tmp_path, pattern):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": pattern,
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.access_pattern == pattern
        cfg_text = (tmp_path / ".agent-env" / "config.toml").read_text()
        assert f'organization_mode = "{pattern}"' in cfg_text

    def test_invalid_pattern_falls_back_to_both(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "invalid_mode",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.access_pattern == "both"

    def test_config_loads_organization_mode(self, tmp_path):
        _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        cfg = Config.load(str(tmp_path / ".agent-env" / "config.toml"))
        assert cfg.organization_mode == "agent"


# ── Q5: AI tools → beacon targets ───────────────────────────────────────────

class TestQ5AITools:
    def test_claude_code_adds_claude_md(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert "CLAUDE.md" in result.beacon_targets

    def test_cursor_adds_cursorrules(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["cursor"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert ".cursorrules" in result.beacon_targets

    def test_all_tools_produces_all_beacons(self, tmp_path):
        all_keys = [k for k, _, _ in AI_TOOLS]
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "both",
            "ai_tools": all_keys,
            "consolidate": [],
            "confirm_write": True,
        })
        all_beacons = {fn for _, _, fn in AI_TOOLS}
        assert set(result.beacon_targets) == all_beacons

    def test_empty_tools_defaults_to_agents_md(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": [],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.beacon_targets == ["AGENTS.md"]

    def test_beacons_persisted_in_config(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "both",
            "ai_tools": ["claude_code", "agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        cfg_text = (tmp_path / ".agent-env" / "config.toml").read_text()
        for beacon in result.beacon_targets:
            assert beacon in cfg_text

    def test_beacons_deduplicated(self, tmp_path):
        # agents_md and another tool that would produce the same file
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "both",
            "ai_tools": ["agents_md", "agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.beacon_targets.count("AGENTS.md") == 1


# ── Q6: Consolidation ────────────────────────────────────────────────────────

class TestQ6Consolidation:
    def _make_project_dir(self, parent, name):
        d = parent / name
        d.mkdir()
        (d / ".git").mkdir()  # make it a candidate
        return d

    def test_confirmed_folder_moved_into_workspace(self, tmp_path):
        proj = self._make_project_dir(tmp_path, "my-project")
        assert proj.exists()

        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": ["my-project"],
            "confirm_write": True,
        })

        dest = tmp_path / "workspace" / "my-project"
        assert dest.exists(), "confirmed project should be moved to workspace"
        assert not proj.exists(), "original location should no longer exist"
        assert any(p["name"] == "my-project" for p in result.projects)

    def test_rejected_folder_stays_put(self, tmp_path):
        proj = self._make_project_dir(tmp_path, "stay-here")
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],             # no accepts
            "consolidate_skip": ["stay-here"],
            "confirm_write": True,
        })
        assert proj.exists(), "rejected folder must not be moved"
        assert "stay-here" in result.skip_list

    def test_rejected_folder_lands_in_skip_list(self, tmp_path):
        self._make_project_dir(tmp_path, "rejected-proj")
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        # In non-interactive mode, unlisted candidates auto-go to skip_list
        assert "rejected-proj" in result.skip_list

    def test_skip_list_persisted_in_config(self, tmp_path):
        self._make_project_dir(tmp_path, "skip-this")
        _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        cfg_text = (tmp_path / ".agent-env" / "config.toml").read_text()
        assert "skip-this" in cfg_text

    def test_move_only_inside_tmp_root(self, tmp_path):
        """Consolidation MOVE must never escape the tmp root."""
        proj = self._make_project_dir(tmp_path, "safe-proj")
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": ["safe-proj"],
            "confirm_write": True,
        })
        dest = result.projects[0]["path"]
        assert str(dest).startswith(str(tmp_path)), (
            "Moved project must remain inside tmp root"
        )

    def test_no_candidates_empty_consolidation(self, tmp_path):
        """No project dirs → empty consolidation; skip_list stays empty."""
        result = _run(tmp_path, {
            "industry": "research",
            "tasks": ["research"],
            "access_pattern": "both",
            "ai_tools": ["agents_md"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert result.wrote
        # No candidates discovered → nothing was rejected into the skip list.
        assert result.skip_list == [], (
            "No candidates discovered → skip_list must be empty"
        )

    def test_existing_workspace_projects_listed(self, tmp_path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        (ws / "existing-project").mkdir()
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert any(p["name"] == "existing-project" for p in result.projects)

    def test_consolidate_evil_path_ignored(self, tmp_path):
        """'../evil' and similar injection entries in Q6 consolidate are
        harmlessly ignored.

        Safety via .name comparison: _scan_candidates returns Path objects
        whose .name is the filesystem basename (can never contain '/' or '..'),
        so a '../evil' entry in the pre-answers consolidate list can never match
        any candidate name and is silently dropped.  The dest path is always
        workspace_path / candidate.name — constructed from the *discovered*
        name, not the user-supplied string — so there is no traversal vector.
        """
        self._make_project_dir(tmp_path, "real-project")

        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            # Injection attempts that can never match any real candidate.name
            # because filesystem basenames cannot contain '/' or '..'.
            "consolidate": ["../evil", "../../escape", "/abs/path"],
            "confirm_write": True,
        })

        # real-project was not in the consolidate accept list → stays in place
        assert (tmp_path / "real-project").exists(), \
            "unlisted real project must not be moved"
        # No directory was created outside the tmp root
        assert not (tmp_path.parent / "evil").exists(), \
            "../evil must not be created outside the tmp root"
        # Injection names did not appear as project entries
        evil_names = {"../evil", "../../escape", "/abs/path"}
        project_names = {p["name"] for p in result.projects}
        assert not evil_names.intersection(project_names), \
            "injection names must not appear in the projects list"
        # real-project landed in skip_list (not consolidated = non-interactive reject)
        assert "real-project" in result.skip_list

    def test_project_entry_in_agent_map(self, tmp_path):
        self._make_project_dir(tmp_path, "maptest-proj")
        _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": ["maptest-proj"],
            "confirm_write": True,
        })
        map_text = (tmp_path / "agent_map.md").read_text()
        assert "maptest-proj" in map_text


# ── Output: config.toml ──────────────────────────────────────────────────────

class TestConfigOutput:
    def test_config_toml_valid_toml(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        cfg_path = tmp_path / ".agent-env" / "config.toml"
        assert cfg_path.exists()
        # Config.load() validates the TOML
        cfg = Config.load(str(cfg_path))
        assert cfg.schema_version == "1.0"

    def test_config_sets_home_to_root(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        cfg = Config.load(str(tmp_path / ".agent-env" / "config.toml"))
        assert cfg.home_template == str(tmp_path)

    def test_config_interview_flags(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        cfg = Config.load(str(tmp_path / ".agent-env" / "config.toml"))
        flags = cfg.interview_flags
        assert flags["industry"] == "software"
        assert flags["knowledge_layer"] is True
        assert flags["data_layer"] is True
        assert flags["maintenance_loop"] is True

    def test_tidy_disabled_by_default(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        cfg = Config.load(str(tmp_path / ".agent-env" / "config.toml"))
        assert cfg.tidy_enabled is False

    def test_config_no_personal_strings(self, tmp_path, minimal_pre):
        """config.toml must contain no personal strings from the live machine."""
        _run(tmp_path, minimal_pre)
        cfg_text = (tmp_path / ".agent-env" / "config.toml").read_text()
        real_home = str(Path.home())
        assert real_home not in cfg_text, (
            "config.toml contains real $HOME path — isolation violated"
        )


# ── Output: agent_map.md ─────────────────────────────────────────────────────

class TestAgentMapOutput:
    def test_schema_comment_present(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        text = (tmp_path / "agent_map.md").read_text()
        assert "<!-- agent-env schema: 1.0 -->" in text

    def test_rooms_table_present(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        text = (tmp_path / "agent_map.md").read_text()
        assert "## Available Rooms" in text
        assert "| Room" in text
        assert "| Path" in text

    def test_projects_table_present(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        text = (tmp_path / "agent_map.md").read_text()
        assert "## Active Projects" in text
        assert "| Project" in text

    def test_hostname_in_map(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        text = (tmp_path / "agent_map.md").read_text()
        assert socket.gethostname() in text

    def test_rooms_appear_in_rooms_table(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review", "documentation"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        text = (tmp_path / "agent_map.md").read_text()
        for room in result.rooms:
            assert room.capitalize() in text

    def test_no_personal_strings_in_map(self, tmp_path, minimal_pre):
        _run(tmp_path, minimal_pre)
        text = (tmp_path / "agent_map.md").read_text()
        real_home = str(Path.home())
        assert real_home not in text, (
            "agent_map.md contains real $HOME path — isolation violated"
        )


# ── check passes after init + sync ──────────────────────────────────────────

class TestCheckPasses:
    def test_init_map_passes_check(self, tmp_path, minimal_pre):
        """The init-produced map must pass `agent-env check`."""
        run_interview(tmp_path, pre=minimal_pre, confirm_map=False, sync=True)

        # Build env from the written config
        cfg = Config.load(str(tmp_path / ".agent-env" / "config.toml"))
        env = Environment(tmp_path, cfg)

        report = cli.run_check(env)
        assert report.ok, (
            f"check failed after init:\n"
            + "\n".join(report.errors)
        )

    def test_init_map_passes_validate_agent_map(self, tmp_path, minimal_pre):
        run_interview(tmp_path, pre=minimal_pre, confirm_map=False, sync=True)
        map_text = (tmp_path / "agent_map.md").read_text()
        problems = cli.validate_agent_map(map_text)
        assert not problems, f"Validation problems: {problems}"

    def test_legal_map_passes_check(self, tmp_path, legal_pre):
        run_interview(tmp_path, pre=legal_pre, confirm_map=False, sync=True)
        cfg = Config.load(str(tmp_path / ".agent-env" / "config.toml"))
        env = Environment(tmp_path, cfg)
        report = cli.run_check(env)
        assert report.ok, "\n".join(report.errors)


# ── Re-run detection ─────────────────────────────────────────────────────────

class TestRerun:
    def test_fresh_run_writes_config(self, tmp_path, minimal_pre):
        result = _run(tmp_path, minimal_pre)
        assert result.wrote
        assert (tmp_path / ".agent-env" / "config.toml").exists()

    def test_rerun_fresh_mode_overwrites(self, tmp_path, minimal_pre):
        # First run
        _run(tmp_path, minimal_pre)
        first_text = (tmp_path / "agent_map.md").read_text()

        # Second run with different industry, rerun_mode="fresh"
        second_pre = dict(minimal_pre,
                          industry="legal",
                          industry_label="Legal",
                          tasks=["document_review"],
                          rerun_mode="fresh")
        result2 = _run(tmp_path, second_pre)
        second_text = (tmp_path / "agent_map.md").read_text()

        assert result2.wrote
        assert "Legal" in second_text

    def test_rerun_aborted_leaves_existing(self, tmp_path, minimal_pre):
        # First run
        _run(tmp_path, minimal_pre)
        original = (tmp_path / "agent_map.md").read_text()

        # Second run without rerun_mode and no confirm → aborts (DictIO default confirm=True)
        # We override the confirm default to False (abort)
        sink = []
        io = DictIO({"confirm_write": False}, sink=sink)
        # No rerun_mode, existing config → asks confirm; DictIO returns default=True for confirm...
        # To test abort, we need confirm=False on the re-run prompt.
        # DictIO.confirm always returns the `default` argument. The re-run prompt default=False.
        result = run_interview(tmp_path, pre={}, io=io, confirm_map=False, sync=False)
        # With empty pre and existing config, DictIO's confirm(default=False) returns False → aborts
        assert not result.wrote
        assert (tmp_path / "agent_map.md").read_text() == original


# ── CLI integration ──────────────────────────────────────────────────────────

class TestCLIInit:
    def _answers_file(self, tmp_path, pre):
        af = tmp_path / "answers.json"
        af.write_text(json.dumps(pre))
        return af

    def test_init_via_cli_defaults(self, tmp_path):
        argv = ["init", "--root", str(tmp_path), "--defaults"]
        rc = cli.main(argv)
        assert rc == 0
        assert (tmp_path / "agent_map.md").exists()

    def test_init_via_cli_from_answers(self, tmp_path, minimal_pre):
        af = self._answers_file(tmp_path, minimal_pre)
        argv = ["init", "--root", str(tmp_path), "--from-answers", str(af)]
        rc = cli.main(argv)
        assert rc == 0
        assert (tmp_path / "agent_map.md").exists()

    def test_init_invalid_answers_file(self, tmp_path):
        bad = tmp_path / "bad.json"
        bad.write_text("NOT JSON {{{")
        argv = ["init", "--root", str(tmp_path), "--from-answers", str(bad)]
        rc = cli.main(argv)
        assert rc == 2

    def test_init_missing_answers_file(self, tmp_path):
        argv = ["init", "--root", str(tmp_path),
                "--from-answers", str(tmp_path / "no_such.json")]
        rc = cli.main(argv)
        assert rc == 2

    def test_init_then_check_passes(self, tmp_path, minimal_pre):
        af = self._answers_file(tmp_path, minimal_pre)
        cli.main(["init", "--root", str(tmp_path), "--from-answers", str(af)])

        cfg = Config.load(str(tmp_path / ".agent-env" / "config.toml"))
        env = Environment(tmp_path, cfg)
        report = cli.run_check(env)
        assert report.ok, "\n".join(report.errors)


# ── Helpers and edge cases ───────────────────────────────────────────────────

class TestHelpers:
    def test_tasks_to_rooms_dedup(self):
        rooms = tasks_to_rooms(["code_review", "debugging", "testing"])
        assert rooms.count("dev") == 1

    def test_tasks_to_rooms_order_preserved(self):
        rooms = tasks_to_rooms(["code_review", "documentation"])
        assert rooms.index("dev") < rooms.index("docs")

    def test_get_constraint_specific(self):
        c = get_constraint("software", "dev")
        assert c == ROOM_CONSTRAINTS[("software", "dev")]

    def test_get_constraint_generic_fallback(self):
        c = get_constraint("other", "dev")
        # Should fall back to (None, "dev")
        assert c == ROOM_CONSTRAINTS[(None, "dev")]

    def test_get_constraint_ultimate_fallback(self):
        from agent_env.interview import GENERIC_CONSTRAINT
        c = get_constraint("other", "nonexistent_room")
        assert c == GENERIC_CONSTRAINT

    def test_scan_candidates_finds_git_dirs(self, tmp_path):
        proj = tmp_path / "my-project"
        proj.mkdir()
        (proj / ".git").mkdir()
        candidates = _scan_candidates(tmp_path, tmp_path / "workspace")
        assert proj in candidates

    def test_scan_candidates_skips_workspace(self, tmp_path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        (ws / ".git").mkdir()  # workspace itself has a .git
        candidates = _scan_candidates(tmp_path, ws)
        assert ws not in candidates

    def test_scan_candidates_skips_dotdirs(self, tmp_path):
        hidden = tmp_path / ".hidden-proj"
        hidden.mkdir()
        (hidden / ".git").mkdir()
        candidates = _scan_candidates(tmp_path, tmp_path / "workspace")
        assert hidden not in candidates

    def test_scan_candidates_skips_non_projects(self, tmp_path):
        plain = tmp_path / "just-a-folder"
        plain.mkdir()  # no project signature
        candidates = _scan_candidates(tmp_path, tmp_path / "workspace")
        assert plain not in candidates

    def test_toml_str_list_empty(self):
        assert _toml_str_list([]) == "[]"

    def test_toml_str_list_single(self):
        assert _toml_str_list(["AGENTS.md"]) == '["AGENTS.md"]'

    def test_toml_str_list_multiple(self):
        result = _toml_str_list(["a", "b"])
        assert result == '["a", "b"]'

    def test_build_config_toml_roundtrips(self, tmp_path):
        from agent_env.interview import InterviewResult
        result = InterviewResult(
            root=tmp_path,
            hostname="testhost",
            industry_key="software",
            industry_label="Software Development",
            tasks=["code_review"],
            rooms=["dev"],
            rules={"dev": "Test rule."},
            access_pattern="agent",
            ai_tools=["claude_code"],
            beacon_targets=["CLAUDE.md"],
            workspace_str="~/workspace",
            projects=[],
            skip_list=[],
            room_skills={},
        )
        toml_text = _build_config_toml(result)
        # Write and load to verify valid TOML
        cfg_path = tmp_path / ".agent-env" / "config.toml"
        cfg_path.parent.mkdir(parents=True)
        cfg_path.write_text(toml_text)
        cfg = Config.load(str(cfg_path))
        assert cfg.organization_mode == "agent"
        assert cfg.tidy_enabled is False

    def test_build_agent_map_has_all_sections(self, tmp_path):
        from agent_env.interview import InterviewResult
        result = InterviewResult(
            root=tmp_path,
            hostname="testhost",
            industry_key="software",
            industry_label="Software Development",
            tasks=["code_review", "documentation"],
            rooms=["dev", "docs"],
            rules={"dev": "Rule A.", "docs": "Rule B."},
            access_pattern="agent",
            ai_tools=["claude_code"],
            beacon_targets=["CLAUDE.md"],
            workspace_str="~/workspace",
            projects=[{"name": "myproj", "path": tmp_path / "workspace" / "myproj"}],
            skip_list=[],
            room_skills={},
        )
        text = _build_agent_map(result)
        assert "<!-- agent-env schema:" in text
        assert "## Available Rooms" in text
        assert "## Active Projects" in text
        assert "## Core Directives" in text
        assert "| Dev" in text or "| dev" in text.lower()
        assert "myproj" in text


# ── DictIO adapter ───────────────────────────────────────────────────────────

class TestDictIO:
    def test_output_captured(self):
        sink = []
        io = DictIO({}, sink=sink)
        io.out("hello")
        assert "hello" in sink

    def test_output_sink_none(self, capsys):
        io = DictIO({}, sink=None)
        io.out("no sink — should not raise")
        # Output is silently discarded: nothing written to stdout or stderr.
        captured = capsys.readouterr()
        assert captured.out == "", "DictIO with sink=None must not write to stdout"
        assert captured.err == "", "DictIO with sink=None must not write to stderr"

    def test_prompt_returns_default(self):
        io = DictIO({})
        assert io.prompt("q", default="x") == "x"

    def test_prompt_no_default_returns_empty(self):
        io = DictIO({})
        assert io.prompt("q") == ""

    def test_confirm_returns_default(self):
        io = DictIO({})
        assert io.confirm("q?", default=True) is True
        assert io.confirm("q?", default=False) is False

    def test_menu_returns_default(self):
        opts = [("a", "A"), ("b", "B")]
        io = DictIO({})
        assert io.menu(opts, default=1) == 1

    def test_multiselect_returns_all_by_default(self):
        opts = [("a", "A"), ("b", "B"), ("c", "C")]
        io = DictIO({})
        assert io.multiselect(opts) == [0, 1, 2]

    def test_multiselect_explicit_defaults(self):
        opts = [("a", "A"), ("b", "B"), ("c", "C")]
        io = DictIO({})
        assert io.multiselect(opts, defaults=[0, 2]) == [0, 2]


# ── InterviewIO methods (monkeypatched input) ────────────────────────────────

class TestInterviewIO:
    """Cover InterviewIO paths by monkeypatching builtins.input."""

    def test_out_prints(self, capsys):
        from agent_env.interview import InterviewIO
        io = InterviewIO()
        io.out("hello world")
        assert "hello world" in capsys.readouterr().out

    def test_prompt_returns_answer(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "my answer")
        io = InterviewIO()
        assert io.prompt("Question?") == "my answer"

    def test_prompt_returns_default_on_empty(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "")
        io = InterviewIO()
        assert io.prompt("Q?", default="fallback") == "fallback"

    def test_menu_returns_valid_choice(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "2")
        io = InterviewIO()
        opts = [("a", "A"), ("b", "B"), ("c", "C")]
        assert io.menu(opts) == 1

    def test_menu_returns_default_on_empty(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "")
        io = InterviewIO()
        opts = [("a", "A"), ("b", "B")]
        assert io.menu(opts, default=1) == 1

    def test_menu_rejects_bad_then_accepts(self, monkeypatch):
        from agent_env.interview import InterviewIO
        answers = iter(["bad", "99", "1"])
        monkeypatch.setattr("builtins.input", lambda _: next(answers))
        io = InterviewIO()
        opts = [("a", "A"), ("b", "B")]
        assert io.menu(opts) == 0  # "1" → index 0

    def test_multiselect_returns_selected(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "1,3")
        io = InterviewIO()
        opts = [("a", "A"), ("b", "B"), ("c", "C")]
        assert io.multiselect(opts) == [0, 2]

    def test_multiselect_empty_keeps_defaults(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "")
        io = InterviewIO()
        opts = [("a", "A"), ("b", "B")]
        assert io.multiselect(opts, defaults=[1]) == [1]

    def test_multiselect_rejects_bad_then_accepts(self, monkeypatch):
        from agent_env.interview import InterviewIO
        answers = iter(["bad input", "0", "1"])
        monkeypatch.setattr("builtins.input", lambda _: next(answers))
        io = InterviewIO()
        opts = [("a", "A"), ("b", "B")]
        result = io.multiselect(opts)
        assert result == [0]  # "1" → index 0

    def test_confirm_yes(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "y")
        io = InterviewIO()
        assert io.confirm("OK?") is True

    def test_confirm_no(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "n")
        io = InterviewIO()
        assert io.confirm("OK?", default=True) is False

    def test_confirm_empty_returns_default(self, monkeypatch):
        from agent_env.interview import InterviewIO
        monkeypatch.setattr("builtins.input", lambda _: "")
        io = InterviewIO()
        assert io.confirm("OK?", default=False) is False


# ── Skills scan ───────────────────────────────────────────────────────────────

class TestSkillsScan:
    def test_skills_scanned_into_rooms(self, tmp_path):
        """Skills whose names contain room keywords are assigned to that room."""
        skills = tmp_path / ".agents" / "skills"
        skills.mkdir(parents=True)
        (skills / "dev-linter").mkdir()
        (skills / "research-start").mkdir()
        (skills / "generic-tool").mkdir()

        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review", "research"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        assert "dev-linter" in result.room_skills.get("dev", [])
        assert "research-start" in result.room_skills.get("research", [])

    def test_unmatched_skills_go_to_first_room(self, tmp_path):
        skills = tmp_path / ".agents" / "skills"
        skills.mkdir(parents=True)
        (skills / "mystery-tool").mkdir()

        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        first_room = result.rooms[0]
        assert "mystery-tool" in result.room_skills.get(first_room, [])

    def test_skills_written_to_config_when_present(self, tmp_path):
        skills = tmp_path / ".agents" / "skills"
        skills.mkdir(parents=True)
        (skills / "dev-tool").mkdir()

        _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        cfg_text = (tmp_path / ".agent-env" / "config.toml").read_text()
        assert "dev-tool" in cfg_text

    def test_nonexistent_skills_dir_ok(self, tmp_path):
        result = _run(tmp_path, {
            "industry": "software",
            "tasks": ["code_review"],
            "access_pattern": "agent",
            "ai_tools": ["claude_code"],
            "consolidate": [],
            "confirm_write": True,
        })
        # No skills dir → empty room_skills or empty lists
        for room in result.rooms:
            assert result.room_skills.get(room, []) == []


# ── Scan candidates edge cases ───────────────────────────────────────────────

class TestScanCandidatesEdgeCases:
    def test_nonexistent_root_returns_empty(self, tmp_path):
        candidates = _scan_candidates(tmp_path / "nonexistent", tmp_path / "ws")
        assert candidates == []

    def test_symlinks_not_included(self, tmp_path):
        proj = tmp_path / "real-proj"
        proj.mkdir()
        (proj / ".git").mkdir()
        link = tmp_path / "linked-proj"
        link.symlink_to(proj)
        candidates = _scan_candidates(tmp_path, tmp_path / "workspace")
        assert link not in candidates
        assert proj in candidates

    def test_skip_dirs_excluded(self, tmp_path):
        skip = tmp_path / "workspace"
        skip.mkdir()
        (skip / ".git").mkdir()
        candidates = _scan_candidates(tmp_path, skip)
        assert skip not in candidates


# ── Build helpers coverage ───────────────────────────────────────────────────

class TestBuildHelpersCoverage:
    def test_build_agent_map_empty_rooms_fallback(self, tmp_path):
        """_build_agent_map with empty rooms uses the general fallback row."""
        result = InterviewResult(
            root=tmp_path,
            hostname="testhost",
            industry_key="other",
            industry_label="General",
            tasks=[],
            rooms=[],          # empty
            rules={},
            access_pattern="both",
            ai_tools=[],
            beacon_targets=["AGENTS.md"],
            workspace_str="~/workspace",
            projects=[],
            skip_list=[],
            room_skills={},
        )
        text = _build_agent_map(result)
        assert "General" in text
        assert "| Room" in text

    def test_build_config_toml_with_room_skills(self, tmp_path):
        result = InterviewResult(
            root=tmp_path,
            hostname="host",
            industry_key="software",
            industry_label="Software Development",
            tasks=["code_review"],
            rooms=["dev"],
            rules={"dev": "Review all code."},
            access_pattern="agent",
            ai_tools=["claude_code"],
            beacon_targets=["CLAUDE.md"],
            workspace_str="~/workspace",
            projects=[],
            skip_list=[],
            room_skills={"dev": ["code-review", "simplify"]},
        )
        toml_text = _build_config_toml(result)
        assert "[skills.rooms.dev]" in toml_text
        assert "code-review" in toml_text
        assert "simplify" in toml_text


# ── Interactive consolidation (pre=None path) ────────────────────────────────

class TestInteractiveConsolidation:
    """Test the interactive Q6 consolidation branch (pre=None, io=DictIO)."""

    def _make_project_dir(self, parent, name):
        d = parent / name
        d.mkdir()
        (d / ".git").mkdir()
        return d

    def test_interactive_confirm_moves_folder(self, tmp_path):
        """With pre=None + DictIO that confirms=True, candidate is moved."""
        proj = self._make_project_dir(tmp_path, "interactive-proj")

        # DictIO with confirm default=False, but we patch confirm to return True
        # by providing a custom DictIO subclass
        class ConfirmingIO(DictIO):
            def confirm(self, question, default=True):
                if "Move" in question:
                    return True
                return super().confirm(question, default)

        io = ConfirmingIO({})
        result = run_interview(
            tmp_path,
            pre=None,   # interactive mode — no pre
            io=io,
            confirm_map=False,
            sync=False,
        )
        dest = tmp_path / "workspace" / "interactive-proj"
        assert dest.exists(), "confirmed project should be moved"
        assert not proj.exists(), "original should be gone"

    def test_interactive_decline_keeps_folder(self, tmp_path):
        """With pre=None + DictIO that confirms=False, candidate stays put."""
        proj = self._make_project_dir(tmp_path, "stay-proj")

        sink = []
        io = DictIO({}, sink=sink)  # confirm always returns default=False for move
        result = run_interview(
            tmp_path,
            pre=None,
            io=io,
            confirm_map=False,
            sync=False,
        )
        assert proj.exists(), "declined project must not be moved"
        assert "stay-proj" in result.skip_list


# ── module main() entry point ────────────────────────────────────────────────

class TestModuleMain:
    def test_main_defaults(self, tmp_path):
        from agent_env.interview import main
        rc = main(["--root", str(tmp_path), "--defaults"])
        assert rc is None  # main() doesn't return an int explicitly
        assert (tmp_path / "agent_map.md").exists()

    def test_main_from_answers(self, tmp_path, minimal_pre):
        from agent_env.interview import main
        af = tmp_path / "ans.json"
        af.write_text(json.dumps(minimal_pre))
        main(["--root", str(tmp_path), "--from-answers", str(af)])
        assert (tmp_path / "agent_map.md").exists()

    def test_main_no_sync(self, tmp_path):
        from agent_env.interview import main
        main(["--root", str(tmp_path), "--defaults", "--no-sync"])
        # No beacon files, but config and map should exist
        assert (tmp_path / ".agent-env" / "config.toml").exists()

    def test_main_confirm_map_interactive(self, tmp_path, monkeypatch, minimal_pre):
        """confirm_map=True path: show preview and prompt for confirm."""
        from agent_env.interview import main
        af = tmp_path / "ans.json"
        # Remove confirm_write so the preview branch runs
        pre = {k: v for k, v in minimal_pre.items() if k != "confirm_write"}
        af.write_text(json.dumps(pre))
        # Monkeypatch input to return "y" for the confirm prompt
        monkeypatch.setattr("builtins.input", lambda _: "y")
        # confirm_map is True when answers file is provided (pre is not None)
        # but confirm_write not in pre → falls through to io.confirm
        result = run_interview(
            tmp_path, pre=pre, confirm_map=True, sync=False
        )
        assert result.wrote
