#!/usr/bin/env python3
"""
config.py — Machine settings for agent-environment.

`agent_map.md` remains the single source of truth for rooms, projects, and
directives. This config holds only *machine settings*: paths, beacon targets,
skip dirs, project signatures, skill-to-room mappings, and feature flags.

Settings load from TOML (default ``~/.agent-env/config.toml``, or an explicit
``--config`` path) and are merged over the built-in ``DEFAULTS`` below. The
defaults reproduce the original single-machine behavior, so a machine with no
config.toml behaves exactly as it did before the config layer existed.

Runtime is stdlib-only: ``tomllib`` on Python 3.11+, ``tomli`` on 3.10 (declared
in pyproject.toml only for that version).
"""
from __future__ import annotations

import copy
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 path
    import tomli as tomllib


# Schema version stamped into agent_map.md and ~/.agent-env/version (decision #6).
SCHEMA_VERSION = "1.0"

DEFAULT_CONFIG_PATH = Path.home() / ".agent-env" / "config.toml"

# Commented template shipped with the package; `init` (Phase 5) writes config
# from it. It round-trips to DEFAULTS exactly.
TEMPLATE_PATH = Path(__file__).parent / "config.template.toml"


# ── Built-in defaults ───────────────────────────────────────────────────────
# A missing config.toml resolves to exactly these values, which reproduce the
# original behavior of the six scripts. Path templates use "~" to mean "relative
# to the environment root" (see environment.py); "~" as a whole value means the
# root itself.

DEFAULTS = {
    "schema_version": SCHEMA_VERSION,
    "paths": {
        # Root of the environment. "~" => the user's real home (Path.home()).
        "home": "~",
        # Canonical shared skill pool (the single source agents read from).
        "skills_dir": "~/.agents/skills",
        # Process/internal state (config, pidfile, logs, version stamp, backups).
        "state_dir": "~/.agent-env",
    },
    "discovery": {
        "scan_home": True,
        # Directories at the root that are NOT projects. Universal infrastructure
        # only — agent-env layout dirs, dotdirs, venvs, node_modules, macOS system
        # dirs. Machine-specific dirs belong in config.toml (decision: no personal
        # names in shipped defaults).
        "skip_dirs": [
            "rooms", "workspace", "archive", "secrets", "scripts",
            ".agents", ".antigravity", ".cursor", ".vscode",
            ".ssh", ".gnupg", ".config", ".cache", ".local", ".npm",
            ".docker", ".cargo", ".rustup", ".pyenv", ".asdf",
            "node_modules", ".venv", "venv", "__pycache__",
            "Applications", "Desktop", "Documents", "Downloads", "Library",
            "Movies", "Music", "Pictures", "Public",
            ".DS_Store", ".Trash", ".TemporaryItems",
        ],
        # File markers that indicate a directory is a project.
        "project_signatures": [
            ".git", "AGENTS.md", "CLAUDE.md", "package.json", "Cargo.toml",
            "pyproject.toml", "go.mod", "Gemfile", "Makefile", "justfile",
            "PROJECT.md",
        ],
        # Home dirs the user has rejected as projects; never re-offered.
        "skip_list": [],
    },
    "beacons": {
        # Home-level beacon files generated from agent_map.md.
        "home_targets": ["AGENTS.md", "CLAUDE.md", ".cursorrules"],
        # Per-project beacon filename (symlinked to the home AGENTS.md).
        "project_beacon": "AGENTS.md",
    },
    "watch": {
        "paths": ["~/agent_map.md", "~/.agents/skills", "~/Obsidian"],
        "cooldown_seconds": 10,
    },
    "tidy": {
        # Destructive hygiene is OFF by default (decision #7).
        "enabled": False,
        "downloads_archive_days": 7,
        # Files/dirs that are OK at the root (not flagged as stray). Universal
        # set only — no personal project, data, or app-install names. Declare
        # machine-specific dirs in config.toml (decision: no personal names in
        # shipped defaults).
        "home_whitelist": [
            # macOS system
            "Applications", "Desktop", "Documents", "Downloads", "Library",
            "Movies", "Music", "Pictures", "Public",
            ".DS_Store", ".Trash", ".TemporaryItems",
            # agent-env infrastructure (the 5-layer structure)
            "rooms", "workspace", "archive", "secrets", "scripts", "data",
            "Obsidian",
            # Tool dotdirs
            ".agents", ".config", ".antigravity", ".cursor", ".vscode",
            ".ssh", ".gnupg", ".cache", ".local", ".npm", ".docker",
            ".cargo", ".rustup", ".pyenv", ".asdf", ".nvm",
            ".venv", "venv", "__pycache__", "node_modules", "go",
            ".git", ".gitconfig", ".gitignore",
            ".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile",
            ".curlrc", ".npmrc", ".yarnrc",
            # Beacon files
            "AGENTS.md", "CLAUDE.md", ".cursorrules", "agent_map.md",
        ],
        # filename -> action ("delete" | "archive"). Empty by default; declare
        # your own debris files in config.toml (no personal filenames shipped).
        "stray_files": {},
    },
    "skill_pool": {
        # Directories symlinked into the unified pool (decision #8). Each entry:
        #   { source = "~/.my-agent/skills", into = "~/.agents/skills" }
        # Empty by default; configure your own skill-pool sources in config.toml.
        "sources": [],
    },
    "interview": {
        # Written by `agent-env init`; downstream modules read these flags.
        # organization_mode: "agent" | "human" | "both"
        "industry": "",
        "industry_label": "",
        "organization_mode": "both",
        "knowledge_layer": True,
        "data_layer": True,
        "maintenance_loop": True,
    },
    "skills": {
        # ROOM_SKILLS: room -> {description, skills:[...]}. Empty by default — no
        # machine-specific skill names are shipped. Declare your rooms in
        # config.toml (this replaces the default wholesale). Example:
        #   [skills.rooms.research]
        #   description = "Research, writing, summarisation"
        #   skills = ["note-taker", "doc-linter", "data-cleaner"]
        "rooms": {},
        # skill_category_to_room: skill-pool category directory name -> room.
        # Empty by default. Example:
        #   [skills.skill_category_to_room]
        #   "software-development" = "devops"
        #   "data-science" = "research"
        "skill_category_to_room": {},
        # default_room: room to which uncategorised skills are assigned instead
        # of being silently dropped. Configurable so installs without a "devops"
        # room can redirect to whatever catch-all room they prefer.
        "default_room": "devops",
    },
}


def _deep_merge(base, override):
    """Recursively merge ``override`` into a copy of ``base``. Dict values merge
    key-by-key; every other type (lists, scalars) is replaced wholesale, so a
    user who sets a list in config.toml replaces the default list rather than
    appending to it."""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class ConfigError(ValueError):
    """Raised when a config.toml is malformed or fails validation."""


class Config:
    """Merged machine settings with typed accessors.

    ``Config.load(path)`` reads TOML and merges it over ``DEFAULTS``. The raw
    merged mapping is available as ``.data`` for callers that need keys not yet
    surfaced as properties.
    """

    def __init__(self, data):
        self.data = data
        self._validate()

    # ── Construction ────────────────────────────────────────────────────
    @classmethod
    def load(cls, path=None):
        """Load config from ``path`` (or the default location). A missing file
        yields the built-in defaults; a malformed file raises ConfigError."""
        merged = copy.deepcopy(DEFAULTS)
        if path is not None:
            path = Path(path).expanduser()
            if not path.exists():
                raise ConfigError(f"config file not found: {path}")
            user = _read_toml(path)
            merged = _deep_merge(merged, user)
        else:
            default_path = DEFAULT_CONFIG_PATH
            if default_path.exists():
                merged = _deep_merge(merged, _read_toml(default_path))
        return cls(merged)

    @classmethod
    def defaults(cls):
        """A Config built purely from the built-in defaults (no file)."""
        return cls(copy.deepcopy(DEFAULTS))

    # ── Validation ──────────────────────────────────────────────────────
    def _validate(self):
        d = self.data
        if not isinstance(d.get("paths", {}).get("home", "~"), str):
            raise ConfigError("paths.home must be a string")
        for key in ("skip_dirs", "project_signatures", "skip_list"):
            val = d.get("discovery", {}).get(key)
            if val is not None and not isinstance(val, list):
                raise ConfigError(f"discovery.{key} must be a list")
        rooms = d.get("skills", {}).get("rooms", {})
        if not isinstance(rooms, dict):
            raise ConfigError("skills.rooms must be a table")
        for name, room in rooms.items():
            if not isinstance(room, dict) or "skills" not in room:
                raise ConfigError(f"skills.rooms.{name} must define a skills list")
            if not isinstance(room["skills"], list):
                raise ConfigError(f"skills.rooms.{name}.skills must be a list")

    # ── Typed accessors ─────────────────────────────────────────────────
    @property
    def schema_version(self):
        return self.data.get("schema_version", SCHEMA_VERSION)

    @property
    def home_template(self):
        return self.data["paths"]["home"]

    @property
    def skills_dir_template(self):
        return self.data["paths"]["skills_dir"]

    @property
    def state_dir_template(self):
        return self.data["paths"]["state_dir"]

    @property
    def scan_home(self):
        return bool(self.data["discovery"]["scan_home"])

    @property
    def skip_dirs(self):
        return set(self.data["discovery"]["skip_dirs"])

    @property
    def project_signatures(self):
        return list(self.data["discovery"]["project_signatures"])

    @property
    def skip_list(self):
        return list(self.data["discovery"].get("skip_list", []))

    @property
    def home_beacon_targets(self):
        return list(self.data["beacons"]["home_targets"])

    @property
    def project_beacon(self):
        return self.data["beacons"]["project_beacon"]

    @property
    def watch_paths(self):
        return list(self.data["watch"]["paths"])

    @property
    def watch_cooldown(self):
        return int(self.data["watch"]["cooldown_seconds"])

    @property
    def tidy_enabled(self):
        return bool(self.data["tidy"]["enabled"])

    @property
    def downloads_archive_days(self):
        return int(self.data["tidy"]["downloads_archive_days"])

    @property
    def home_whitelist(self):
        return set(self.data["tidy"]["home_whitelist"])

    @property
    def stray_files(self):
        return dict(self.data["tidy"]["stray_files"])

    @property
    def skill_pool_sources(self):
        return list(self.data["skill_pool"]["sources"])

    @property
    def organization_mode(self):
        return self.data.get("interview", {}).get("organization_mode", "both")

    @property
    def interview_flags(self):
        """Raw interview section dict (written by ``agent-env init``)."""
        return dict(self.data.get("interview", {}))

    @property
    def room_skills(self):
        return self.data["skills"]["rooms"]

    @property
    def skill_category_to_room(self):
        """Mapping of skill-pool category directory name → room name."""
        skills = self.data["skills"]
        return dict(skills.get("skill_category_to_room", {}))

    @property
    def skill_default_room(self):
        """Room to assign uncategorised skills that have no mapping."""
        return self.data["skills"].get("default_room", "devops")


def _read_toml(path):
    try:
        with open(path, "rb") as fh:
            return tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"invalid TOML in {path}: {exc}") from exc
