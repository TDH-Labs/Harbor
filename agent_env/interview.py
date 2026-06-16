#!/usr/bin/env python3
"""
interview.py — Onboarding interview for ``agent-env init``.

Implements the 6-question interview from plan.md Phase 5a.  Every question has a
matching key in the *pre-filled answers* dict so the whole flow can run without a
TTY (``--from-answers FILE`` or ``--defaults`` for automation and tests).

Questions
---------
Q1. Industry / field     → seeds constraint templates and terminology
Q2. Tasks AI will do     → one room per task-cluster
Q3. Confirm per-area rules (derived from Q1+Q2; editable, not invented per-run)
Q4. File access pattern  → organization_mode flag persisted in config
Q5. AI tools             → home beacon targets
Q6. Working-files location + scan-and-confirm consolidation (MOVE on explicit
    confirm only; rejected → config skip list)

Automatic (never asked)
-----------------------
hostname, knowledge_layer=true, data_layer=true, maintenance_loop=true

Gated (decision #7)
-------------------
Destructive cleanup stays opt-in/default-off (tidy.enabled = false on fresh
install).

Non-interactive mode
--------------------
Pass ``pre`` dict (or ``--from-answers FILE`` via the CLI) with any subset of::

    {
        "industry": "software",         # industry key or "other"
        "industry_label": "...",        # only needed when industry="other"
        "tasks": ["code_review", ...],  # list of task keys
        "rules": {"dev": "..."},        # overrides for derived constraints
        "access_pattern": "agent",      # "agent"|"human"|"both"
        "ai_tools": ["claude_code"],    # list of tool keys
        "workspace": "~/workspace",     # default
        "consolidate": ["my-proj"],     # names of candidates to MOVE
        "consolidate_skip": [],         # names to reject (→ skip list)
        "confirm_write": true,          # skip the final map-preview confirm
        "rerun_mode": "fresh",          # "fresh"|"update" (skip rerun prompt)
    }

Missing keys fall back to their defaults (no prompting).
"""
from __future__ import annotations

import json
import shutil
import socket
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from agent_env import beacon_sync
from agent_env.config import DEFAULTS, SCHEMA_VERSION, Config
from agent_env.environment import Environment

# ── Q1: Industries ──────────────────────────────────────────────────────────

INDUSTRIES: list[tuple[str, str]] = [
    ("software",   "Software Development"),
    ("legal",      "Legal"),
    ("accounting", "Accounting / Finance"),
    ("research",   "Research / Academia"),
    ("marketing",  "Marketing"),
    ("healthcare", "Healthcare"),
    ("realestate", "Real Estate"),
    ("other",      "Other / Custom"),
]

# ── Q2: Tasks per industry ───────────────────────────────────────────────────

INDUSTRY_TASKS: dict[str, list[tuple[str, str]]] = {
    "software": [
        ("code_review",   "Code review & quality"),
        ("debugging",     "Debugging & troubleshooting"),
        ("documentation", "Writing docs & specs"),
        ("testing",       "Testing & QA"),
        ("architecture",  "Architecture & design"),
        ("research",      "Technical research"),
    ],
    "legal": [
        ("document_review", "Contract & document review"),
        ("legal_research",  "Legal research"),
        ("drafting",        "Drafting & templates"),
        ("compliance",      "Compliance & regulatory"),
        ("client_comms",    "Client communications"),
    ],
    "accounting": [
        ("reporting",      "Financial reporting"),
        ("analysis",       "Data analysis & modeling"),
        ("reconciliation", "Account reconciliation"),
        ("compliance",     "Tax & regulatory compliance"),
        ("research",       "Market research"),
    ],
    "research": [
        ("research",      "Literature & data research"),
        ("data_analysis", "Data analysis"),
        ("writing",       "Academic writing & editing"),
        ("documentation", "Lab notes & protocols"),
        ("peer_review",   "Peer review support"),
    ],
    "marketing": [
        ("content",       "Content creation & editing"),
        ("research",      "Market & competitor research"),
        ("analysis",      "Campaign analysis"),
        ("client_comms",  "Client communications"),
        ("documentation", "Strategy & planning docs"),
    ],
    "healthcare": [
        ("document_review", "Clinical document review"),
        ("research",        "Medical literature research"),
        ("documentation",   "Clinical documentation"),
        ("compliance",      "Regulatory & compliance"),
        ("reporting",       "Outcomes & reporting"),
    ],
    "realestate": [
        ("document_review", "Contract & disclosure review"),
        ("research",        "Market & property research"),
        ("client_comms",    "Client communications"),
        ("reporting",       "Reports & analysis"),
        ("compliance",      "Regulatory compliance"),
    ],
    "other": [
        ("research",      "Research & analysis"),
        ("writing",       "Writing & editing"),
        ("documentation", "Documentation"),
        ("review",        "Review & QA"),
        ("client_comms",  "Communications"),
    ],
}

# ── Task → room mapping ─────────────────────────────────────────────────────
# Many tasks share a room; dict.fromkeys over ordered task list de-dupes rooms.

TASK_TO_ROOM: dict[str, str] = {
    "code_review":    "dev",
    "debugging":      "dev",
    "testing":        "dev",
    "architecture":   "dev",
    "documentation":  "docs",
    "writing":        "docs",
    "document_review": "review",
    "peer_review":    "review",
    "review":         "review",
    "research":       "research",
    "legal_research": "research",
    "data_analysis":  "research",
    "drafting":       "drafting",
    "compliance":     "compliance",
    "client_comms":   "client",
    "reporting":      "reporting",
    "analysis":       "analysis",
    "reconciliation": "accounting",
    "content":        "content",
}

# Room purpose shown in agent_map.md Rooms table
ROOM_PURPOSE: dict[str, str] = {
    "dev":        "Development, code review, testing",
    "docs":       "Documentation, writing, specs",
    "research":   "Research, analysis, literature",
    "review":     "Document review, quality assurance",
    "drafting":   "Drafts, templates, outlines",
    "compliance": "Compliance, regulatory, audits",
    "client":     "Client communications, deliverables",
    "reporting":  "Reporting, dashboards, summaries",
    "analysis":   "Data analysis, modeling, forecasting",
    "accounting": "Bookkeeping, reconciliation, GL",
    "content":    "Content creation, editing, publishing",
}

# ── Q3: Constraint templates ─────────────────────────────────────────────────
# Keyed (industry_key, room_key); (None, room_key) is the generic fallback.
# These are IN-MODULE CONSTANTS — never invented per-run.

ROOM_CONSTRAINTS: dict[tuple[Optional[str], str], str] = {
    # Software
    ("software", "dev"):        "All code reviewed before merge. No secrets in commits. Tests required for new features.",
    ("software", "docs"):       "Docs mirror the current implementation. Code examples are runnable.",
    ("software", "research"):   "Research findings go to research.md; plans to plan.md. Cite sources.",
    # Legal
    ("legal", "review"):        "Privilege check before sharing. No PII in plain text. Attorney review on all outputs.",
    ("legal", "drafting"):      "All drafts require attorney review before sending. Track versions.",
    ("legal", "compliance"):    "File deadlines tracked in project table. Flag missing requirements immediately.",
    ("legal", "research"):      "Cite authoritative sources only. Note when citing secondary sources.",
    ("legal", "client"):        "Professional tone. Escalate sensitive items. No legal advice without review.",
    # Accounting
    ("accounting", "reporting"): "Numbers must trace to source data. Flag any estimates or assumptions.",
    ("accounting", "analysis"):  "Show workings. Materiality thresholds documented. Sources cited.",
    ("accounting", "accounting"): "Every entry has a supporting document. Reconcile monthly.",
    ("accounting", "compliance"): "Filing deadlines tracked. Flag changes in regulation.",
    # Research
    ("research", "research"):   "All claims cited. Raw data stays in the data layer, never in context.",
    ("research", "docs"):       "Lab notes and protocols version-controlled. Replicate-ready.",
    ("research", "review"):     "Peer review comments documented. Track revision rounds.",
    # Marketing
    ("marketing", "content"):   "Brand voice consistent across outputs. Claims must be verifiable.",
    ("marketing", "research"):  "Source data cited. Distinguish primary from secondary research.",
    ("marketing", "analysis"):  "Attribution model documented. Flag data quality issues.",
    # Healthcare
    ("healthcare", "review"):   "No PHI in plain text. HIPAA-compliant handling. De-identify before analysis.",
    ("healthcare", "research"): "IRB status noted. Patient data never leaves the data layer.",
    ("healthcare", "compliance"): "Regulatory filings tracked. Flag deviations from protocol.",
    # Real estate
    ("realestate", "review"):   "Disclosure obligations noted. Flag contingency deadlines.",
    ("realestate", "research"): "Comparable sales sourced and dated. Flag data vintage.",
    ("realestate", "client"):   "Licensed activity only. Flag any compliance touchpoints.",
    # Generic fallbacks
    (None, "dev"):        "Follow project coding conventions. Review before merge.",
    (None, "docs"):       "Documentation kept current. Examples tested.",
    (None, "research"):   "Cite sources. Raw data stays in data layer.",
    (None, "review"):     "Outputs require approval before use.",
    (None, "drafting"):   "Drafts require review before sending.",
    (None, "compliance"): "Track filing deadlines. Flag missing requirements.",
    (None, "analysis"):   "Show workings. Flag assumptions.",
    (None, "content"):    "Consistent style. Claims verifiable.",
    (None, "client"):     "Professional tone. Escalate sensitive items.",
    (None, "reporting"):  "Numbers trace to source. Flag assumptions.",
    (None, "accounting"): "Every entry has a supporting document.",
}

GENERIC_CONSTRAINT = "Files, not databases. Cite sources. Review before final use."

# ── Q4: Access patterns ──────────────────────────────────────────────────────

ACCESS_PATTERNS: list[tuple[str, str]] = [
    ("agent",  "Agent-optimized: agent manages files; SQLite emphasis"),
    ("human",  "Human-legible: friendly folders; you navigate yourself"),
    ("both",   "Both: mixed, supports both workflows"),
]

# ── Q5: AI tools ────────────────────────────────────────────────────────────

# (key, display label, beacon filename)
AI_TOOLS: list[tuple[str, str, str]] = [
    ("agents_md",   "Any AGENTS.md reader (Cursor, Windsurf, Codex…)", "AGENTS.md"),
    ("claude_code", "Claude Code (CLAUDE.md)",                          "CLAUDE.md"),
    ("cursor",      "Cursor (.cursorrules)",                             ".cursorrules"),
]

_TOOL_BEACON: dict[str, str] = {k: fn for k, _, fn in AI_TOOLS}


# ── Result dataclass ─────────────────────────────────────────────────────────

@dataclass
class InterviewResult:
    root: Path
    hostname: str
    industry_key: str
    industry_label: str
    tasks: list
    rooms: list                        # ordered, de-duped room keys
    rules: dict                        # room_key → constraint text
    access_pattern: str
    ai_tools: list                     # tool keys
    beacon_targets: list               # beacon filenames (for config)
    workspace_str: str                 # e.g. "~/workspace"
    projects: list                     # [{"name": str, "path": Path}, ...]
    skip_list: list                    # names to never re-offer in scan
    room_skills: dict                  # room_key → [skill_name, ...]
    wrote: bool = False


# ── IO adapters ──────────────────────────────────────────────────────────────

class InterviewIO:
    """Interactive terminal IO for the interview."""

    def out(self, msg=""):
        print(msg)

    def prompt(self, question, default=None):
        suffix = f" [{default}]" if default is not None else ""
        while True:
            ans = input(f"  {question}{suffix}: ").strip()
            if ans:
                return ans
            if default is not None:
                return str(default)

    def menu(self, options, default=0):
        """Numbered menu; returns 0-based index of choice."""
        for i, (_, label) in enumerate(options, 1):
            self.out(f"  {i:2}. {label}")
        while True:
            raw = input(f"\n  Choice [1-{len(options)}] (default {default+1}): ").strip()
            if not raw:
                return default
            try:
                idx = int(raw) - 1
                if 0 <= idx < len(options):
                    return idx
            except ValueError:
                pass
            self.out(f"  Please enter a number between 1 and {len(options)}.")

    def multiselect(self, options, defaults=None):
        """Multi-select; returns sorted list of 0-based indices."""
        def_set = set(defaults if defaults is not None else range(len(options)))
        for i, (_, label) in enumerate(options, 1):
            mark = "*" if (i - 1) in def_set else " "
            self.out(f"  [{mark}] {i:2}. {label}")
        self.out("\n  Enter numbers (comma-separated). Press Enter to keep starred.")
        while True:
            raw = input("  Selection: ").strip()
            if not raw:
                return sorted(def_set)
            try:
                idxs = [int(x.strip()) - 1 for x in raw.split(",")]
                if idxs and all(0 <= i < len(options) for i in idxs):
                    return sorted(set(idxs))
                self.out(f"  Numbers must be between 1 and {len(options)}.")
            except ValueError:
                self.out("  Use comma-separated numbers, e.g. 1,3.")

    def confirm(self, question, default=True):
        suffix = "[Y/n]" if default else "[y/N]"
        raw = input(f"\n  {question} {suffix}: ").strip().lower()
        if not raw:
            return default
        return raw in ("y", "yes")


class DictIO:
    """Non-interactive IO for tests and automation.

    The ``pre`` dict is used by :func:`run_interview` before calling IO methods,
    so these methods are only reached for fallback values (they should behave as
    safe defaults and never block).
    """

    def __init__(self, pre: dict, sink: Optional[list] = None):
        self._pre = pre
        self._sink = sink  # optional list to capture output for assertions

    def out(self, msg=""):
        if self._sink is not None:
            self._sink.append(str(msg))

    def prompt(self, question, default=None):
        return str(default) if default is not None else ""

    def menu(self, options, default=0):
        return default

    def multiselect(self, options, defaults=None):
        return sorted(defaults if defaults is not None else range(len(options)))

    def confirm(self, question, default=True):
        return default


# ── Helpers ──────────────────────────────────────────────────────────────────

def get_constraint(industry_key: str, room_key: str) -> str:
    """Look up the constraint text for (industry, room), with fallbacks."""
    specific = ROOM_CONSTRAINTS.get((industry_key, room_key))
    if specific:
        return specific
    generic = ROOM_CONSTRAINTS.get((None, room_key))
    if generic:
        return generic
    return GENERIC_CONSTRAINT


def tasks_to_rooms(tasks: list[str]) -> list[str]:
    """Ordered, de-duplicated list of room keys from a list of task keys."""
    return list(dict.fromkeys(
        TASK_TO_ROOM.get(t, "general") for t in tasks
    ))


def _scan_candidates(root: Path, workspace_path: Path) -> list[Path]:
    """Find project-like directories in root, excluding standard infrastructure."""
    skip = set(DEFAULTS["discovery"]["skip_dirs"]) | {
        workspace_path.name,
        ".agent-env",
    }
    sigs = set(DEFAULTS["discovery"]["project_signatures"])
    candidates: list[Path] = []
    if not root.exists():
        return candidates
    try:
        entries = list(root.iterdir())
    except PermissionError:
        return candidates
    for item in entries:
        if not item.is_dir() or item.is_symlink():
            continue
        if item.name.startswith("."):
            continue
        if item.name in skip:
            continue
        for sig in sigs:
            if (item / sig).exists():
                candidates.append(item)
                break
    return sorted(candidates, key=lambda p: p.name.lower())


def _scan_skills_for_rooms(skills_dir: Path, rooms: list[str]) -> dict[str, list[str]]:
    """Scan a skills directory and return a rough room → [skill_name] mapping.

    Skills are assigned to the first matching room whose name appears in the
    skill directory name (or SKILL.md description). Unmatched skills go to the
    first room if any, else are dropped. Returns empty dict when skills_dir
    does not exist.
    """
    if not skills_dir.exists():
        return {}
    result: dict[str, list[str]] = {r: [] for r in rooms}
    if not rooms:
        return result
    try:
        entries = [e for e in skills_dir.iterdir() if e.is_dir()]
    except PermissionError:
        return result
    for entry in sorted(entries, key=lambda p: p.name.lower()):
        assigned = False
        for room in rooms:
            if room in entry.name.lower():
                result[room].append(entry.name)
                assigned = True
                break
        if not assigned:
            result[rooms[0]].append(entry.name)
    return result


def _toml_str_list(lst: list[str]) -> str:
    """Format a list of strings as a TOML inline array."""
    items = ", ".join(f'"{x}"' for x in lst)
    return f"[{items}]"


def _build_config_toml(result: InterviewResult) -> str:
    """Assemble a config.toml string from an interview result.

    No TOML-writer dependency (decision #1): the format is simple enough that a
    template string produces valid, round-trippable TOML.
    """
    lines = [
        "# config.toml — agent-environment machine settings",
        "# Written by `agent-env init`.",
        "# Edit to change machine settings; run `agent-env sync` to regenerate beacons.",
        "",
        f'schema_version = "{SCHEMA_VERSION}"',
        "",
        "[paths]",
        f'home = "{result.root}"',
        'skills_dir = "~/.agents/skills"',
        'state_dir = "~/.agent-env"',
        "",
        "[discovery]",
        "scan_home = true",
        f"skip_list = {_toml_str_list(result.skip_list)}",
        "",
        "[beacons]",
        f"home_targets = {_toml_str_list(result.beacon_targets)}",
        "",
        "[tidy]",
        "# Destructive hygiene is OFF by default (decision #7).",
        "# Enable with `tidy.enabled = true` only when you are ready.",
        "enabled = false",
        "",
        "[interview]",
        f'industry = "{result.industry_key}"',
        f'industry_label = "{result.industry_label}"',
        f'organization_mode = "{result.access_pattern}"',
        "knowledge_layer = true",
        "data_layer = true",
        "maintenance_loop = true",
        "",
    ]
    # Room-skills mapping (only when non-empty)
    if result.room_skills:
        for room, skills in result.room_skills.items():
            if skills:
                lines.append(f"[skills.rooms.{room}]")
                lines.append(f'description = "{ROOM_PURPOSE.get(room, room)}"')
                lines.append(f"skills = {_toml_str_list(skills)}")
                lines.append("")
    return "\n".join(lines)


def _build_agent_map(result: InterviewResult) -> str:
    """Build the full agent_map.md content from an interview result."""
    root_str = str(result.root)

    # Rooms table rows
    room_rows = []
    for room in result.rooms:
        purpose = ROOM_PURPOSE.get(room, room)
        room_rows.append(f"| {room.capitalize()} | {root_str}/rooms/{room}/ | {purpose} |")
    if not room_rows:
        room_rows.append(f"| General | {root_str}/rooms/general/ | Default workspace |")
    rooms_table = "\n".join(room_rows)

    # Projects table rows
    proj_rows = []
    for p in result.projects:
        proj_rows.append(f"| {p['name']} | {p['path']} | Active |")
    projects_table = "\n".join(proj_rows) if proj_rows else ""

    # Constraints section (room_rules referenced in Core Directives)
    constraint_lines = []
    for room in result.rooms:
        constraint = result.rules.get(room, get_constraint(result.industry_key, room))
        constraint_lines.append(f"- **{room.capitalize()}**: {constraint}")
    constraints_md = "\n".join(constraint_lines)

    content = f"""\
<!-- agent-env schema: {SCHEMA_VERSION} -->
# Agent Core Map & Routing Protocol

> The single source of truth for this environment. Edit this file; run
> `agent-env sync` to regenerate all beacons.

## Host Profile

- Machine: {result.hostname}
- Industry: {result.industry_label}
- Organization mode: {result.access_pattern}

## Architectural Overview

This environment uses a 5-layer structure for agent context:
knowledge → data → workspace → rooms → beacons.

## Available Rooms

| Room | Path | Purpose |
|------|------|---------|
{rooms_table}

## Active Projects

| Project | Path | Status |
|---------|------|--------|
{projects_table}

## Per-Area Constraints

{constraints_md}

## Core Directives

1. Never ingest raw data directly into your primary context window.
2. Never traverse outside the environment root unless explicitly asked.
3. Use the compaction workflow: research.md → plan.md → execute from the plan.
4. Knowledge layer: ON. Data layer: ON. Maintenance loop: ON.
5. Destructive cleanup (tidy) is opt-in — never auto-runs.

## Security

- Root scope: {root_str} — all file operations must resolve within this prefix.
- Secrets: ~/secrets/ only, 600 permissions, never committed.
"""
    return content


# ── Core interview driver ────────────────────────────────────────────────────

def run_interview(
    root,
    *,
    pre: Optional[dict] = None,
    io=None,
    confirm_map: bool = True,
    sync: bool = True,
) -> InterviewResult:
    """Run the 6-question onboarding interview and write config.toml + agent_map.md.

    Parameters
    ----------
    root:
        Root directory for the environment (``--root`` value).
    pre:
        Pre-filled answers dict. Any key present skips the corresponding prompt.
        Pass an empty dict (``{}``) for fully-defaulted non-interactive mode.
    io:
        IO adapter. Defaults to :class:`InterviewIO` (interactive terminal).
        Pass a :class:`DictIO` instance for non-interactive operation.
    confirm_map:
        If true, show the assembled agent_map.md and require explicit confirm
        before writing.  Pass ``False`` or set ``pre["confirm_write"] = True``
        to skip the confirm (useful in tests).
    sync:
        If true, run ``beacon_sync.full_sync`` after writing files so that
        ``agent-env check`` passes immediately (beacons generated, version stamp
        written).
    """
    root = Path(root)
    # Detect non-interactive mode BEFORE normalising pre to {} so that
    # `pre={}` (--defaults) is correctly treated as non-interactive.
    _noninteractive = pre is not None
    if pre is None and io is None:
        io = InterviewIO()
    elif pre is not None and io is None:
        io = DictIO(pre)
    pre = pre or {}

    io.out()
    io.out("=== agent-env init: onboarding interview ===")
    io.out("Writes config.toml + agent_map.md for your environment.")
    io.out()

    # ── Re-run detection ────────────────────────────────────────────────────
    state_dir = root / ".agent-env"
    config_path = state_dir / "config.toml"

    if config_path.exists() and "rerun_mode" not in pre:
        io.out(f"Existing config found at {config_path}")
        if not io.confirm("Start fresh (overwrites existing config)?", default=False):
            io.out("Updating existing config is not yet implemented. Aborting.")
            # Return a minimal result without writing
            return InterviewResult(
                root=root, hostname=socket.gethostname(),
                industry_key="", industry_label="", tasks=[], rooms={},
                rules={}, access_pattern="both", ai_tools=[], beacon_targets=[],
                workspace_str="~/workspace", projects=[], skip_list=[],
                room_skills={}, wrote=False,
            )

    # ── Q1: Industry ────────────────────────────────────────────────────────
    io.out("Q1. What industry or field is this environment for?")

    if "industry" in pre:
        ind_key = pre["industry"]
        if ind_key not in dict(INDUSTRIES):
            ind_key = "other"
        ind_label = pre.get("industry_label", dict(INDUSTRIES).get(ind_key, ind_key))
    else:
        idx = io.menu(INDUSTRIES, default=0)
        ind_key, ind_label = INDUSTRIES[idx]
        if ind_key == "other":
            ind_label = io.prompt("Custom industry name", default="General")

    io.out(f"  → {ind_label}")

    # ── Q2: Tasks ───────────────────────────────────────────────────────────
    task_options = INDUSTRY_TASKS.get(ind_key, INDUSTRY_TASKS["other"])
    io.out()
    io.out(f"Q2. Which tasks will AI help with? (for: {ind_label})")

    if "tasks" in pre:
        pre_keys = set(pre["tasks"])
        task_keys = [k for k, _ in task_options if k in pre_keys]
        if not task_keys:
            # Fall back to all tasks if pre_keys matches nothing (e.g. custom industry)
            task_keys = [k for k, _ in task_options]
    else:
        idxs = io.multiselect(task_options, defaults=list(range(len(task_options))))
        task_keys = [task_options[i][0] for i in idxs]

    if not task_keys:
        task_keys = [task_options[0][0]]  # require at least one

    rooms = tasks_to_rooms(task_keys)
    io.out(f"  → rooms: {', '.join(rooms)}")

    # ── Q3: Rules ───────────────────────────────────────────────────────────
    io.out()
    io.out("Q3. Review per-area constraints (derived from your industry and tasks).")

    rules: dict[str, str] = {}
    for room in rooms:
        rules[room] = get_constraint(ind_key, room)

    if "rules" in pre:
        rules.update(pre["rules"])
    else:
        for room in rooms:
            io.out(f"\n  Room '{room}' — {ROOM_PURPOSE.get(room, room)}")
            io.out(f"  Default: {rules[room]}")
            edited = io.prompt("Constraint (Enter to keep)", default=rules[room])
            rules[room] = edited

    # ── Q4: Access pattern ──────────────────────────────────────────────────
    io.out()
    io.out("Q4. How will you primarily access your working files?")

    if "access_pattern" in pre:
        access_pattern = pre["access_pattern"]
        if access_pattern not in {k for k, _ in ACCESS_PATTERNS}:
            access_pattern = "both"
    else:
        idx = io.menu(ACCESS_PATTERNS, default=2)  # default: "both"
        access_pattern = ACCESS_PATTERNS[idx][0]

    io.out(f"  → {access_pattern}")

    # ── Q5: AI tools ────────────────────────────────────────────────────────
    io.out()
    io.out("Q5. Which AI tools will you use?")

    if "ai_tools" in pre:
        ai_tool_keys = pre["ai_tools"]
    else:
        all_idxs = list(range(len(AI_TOOLS)))
        idxs = io.multiselect([(k, lbl) for k, lbl, _ in AI_TOOLS], defaults=all_idxs)
        ai_tool_keys = [AI_TOOLS[i][0] for i in idxs]

    # Map tool keys to beacon filenames; de-duplicate preserving order
    beacon_targets = list(dict.fromkeys(
        _TOOL_BEACON[k] for k in ai_tool_keys if k in _TOOL_BEACON
    ))
    if not beacon_targets:
        beacon_targets = ["AGENTS.md"]

    io.out(f"  → beacons: {', '.join(beacon_targets)}")

    # ── Q6: Working files + consolidation ───────────────────────────────────
    workspace_str = pre.get("workspace", "~/workspace")
    ws_rel = workspace_str[2:] if workspace_str.startswith("~/") else workspace_str
    workspace_path = root / ws_rel

    io.out()
    io.out(f"Q6. Working files → {workspace_str} (under {root})")
    io.out("    Scanning for project folders to consolidate...")

    candidates = _scan_candidates(root, workspace_path)

    moved_projects: list[dict] = []
    skip_list: list[str] = list(pre.get("consolidate_skip", []))
    consolidate_accept = set(pre.get("consolidate", []))
    is_noninteractive = _noninteractive

    for candidate in candidates:
        if candidate.name in skip_list:
            continue
        dest = workspace_path / candidate.name

        if consolidate_accept and candidate.name in consolidate_accept:
            # Explicitly accepted in pre-answers
            workspace_path.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                shutil.move(str(candidate), str(dest))
            moved_projects.append({"name": candidate.name, "path": dest})
        elif is_noninteractive:
            # Non-interactive with no explicit accept → reject/skip
            if candidate.name not in skip_list:
                skip_list.append(candidate.name)
        else:
            # Interactive: ask per-item
            io.out(f"\n  Found: {candidate}")
            io.out(f"  Move to: {dest}")
            if io.confirm(f"Move '{candidate.name}' into workspace?", default=False):
                workspace_path.mkdir(parents=True, exist_ok=True)
                if not dest.exists():
                    shutil.move(str(candidate), str(dest))
                moved_projects.append({"name": candidate.name, "path": dest})
            else:
                if candidate.name not in skip_list:
                    skip_list.append(candidate.name)

    # Existing workspace entries (already in workspace before the interview)
    existing_projects: list[dict] = []
    if workspace_path.exists():
        moved_names = {p["name"] for p in moved_projects}
        for item in sorted(workspace_path.iterdir(), key=lambda p: p.name.lower()):
            if item.is_dir() and not item.name.startswith("."):
                if item.name not in moved_names:
                    existing_projects.append({"name": item.name, "path": item})

    all_projects = moved_projects + existing_projects

    # ── Automatic: skills scan ──────────────────────────────────────────────
    skills_dir = root / ".agents" / "skills"
    room_skills = _scan_skills_for_rooms(skills_dir, rooms)

    hostname = socket.gethostname()

    result = InterviewResult(
        root=root,
        hostname=hostname,
        industry_key=ind_key,
        industry_label=ind_label,
        tasks=task_keys,
        rooms=rooms,
        rules=rules,
        access_pattern=access_pattern,
        ai_tools=ai_tool_keys,
        beacon_targets=beacon_targets,
        workspace_str=workspace_str,
        projects=all_projects,
        skip_list=skip_list,
        room_skills=room_skills,
    )

    # ── Map preview + confirm ───────────────────────────────────────────────
    map_content = _build_agent_map(result)

    should_write = True
    if confirm_map:
        if "confirm_write" in pre:
            should_write = bool(pre["confirm_write"])
        else:
            io.out("\n=== agent_map.md preview ===")
            io.out(map_content)
            io.out("=== end of preview ===")
            should_write = io.confirm(
                "Write config.toml and agent_map.md?", default=True
            )

    if not should_write:
        io.out("Aborted. Nothing written.")
        return result

    # ── Write files ─────────────────────────────────────────────────────────
    state_dir.mkdir(parents=True, exist_ok=True)
    config_toml = _build_config_toml(result)
    config_path.write_text(config_toml)
    (root / "agent_map.md").write_text(map_content)

    if sync:
        # Load the freshly-written config and run a full sync so that
        # `agent-env check` passes immediately (beacons + version stamp).
        try:
            config = Config.load(str(config_path))
            env = Environment(root, config, config_path=str(config_path))
            beacon_sync.full_sync(env)
        except Exception as exc:  # pragma: no cover
            io.out(f"  Warning: post-init sync failed: {exc}")

    result.wrote = True
    io.out()
    io.out(f"Done. Written to {root}:")
    io.out(f"  {config_path}")
    io.out(f"  {root}/agent_map.md")
    io.out()
    io.out("Next: run 'agent-env setup' to create the directory structure.")
    return result


# ── CLI entry point ──────────────────────────────────────────────────────────

def main(argv=None):
    """``python -m agent_env.interview`` entry point."""
    import argparse
    parser = argparse.ArgumentParser(
        prog="agent-env-interview",
        description="Run the agent-env onboarding interview.",
    )
    parser.add_argument("--root", metavar="DIR", default=None,
                        help="environment root (default: $HOME)")
    parser.add_argument("--from-answers", metavar="FILE", dest="answers_file",
                        help="JSON file with pre-filled answers (non-interactive)")
    parser.add_argument("--defaults", action="store_true",
                        help="use all defaults without prompting")
    parser.add_argument("--no-sync", action="store_true",
                        help="skip the post-interview beacon sync")
    args = parser.parse_args(argv)

    root = Path(args.root).expanduser() if args.root else Path.home()

    pre = None
    if args.defaults:
        pre = {}
    elif args.answers_file:
        with open(args.answers_file) as fh:
            pre = json.load(fh)

    run_interview(root, pre=pre, confirm_map=(pre is None), sync=not args.no_sync)


if __name__ == "__main__":
    sys.exit(main())
