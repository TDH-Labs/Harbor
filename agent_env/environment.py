#!/usr/bin/env python3
"""
environment.py — Resolve all paths from a root + Config.

Every filesystem operation in the package flows through an ``Environment``: it
owns the root directory and derives every other path from it. This is what makes
the modules testable against a ``tmp_path`` root (decision #4) and what lets the
generated beacon text reference the *actual* resolved home instead of a
hardcoded home path (the Phase 1 path-abstraction goal).

Path templates in config use ``~`` to mean "relative to the environment root":
``~`` alone is the root, ``~/.agents/skills`` is ``root/.agents/skills``. An
absolute template is used as-is; a bare relative template is joined to the root.
"""
from __future__ import annotations

from pathlib import Path

from agent_env.config import Config


class Environment:
    """Root directory plus every path derived from it, backed by a Config."""

    def __init__(self, root, config, config_path=None):
        self.root = Path(root)
        self.config = config
        # The config.toml this Environment was loaded from, if any. The watcher's
        # start() re-passes it to the daemon it spawns so the daemon resolves the
        # same root; None when built from defaults or an in-memory Config.
        self.config_path = config_path

    # ── Construction ────────────────────────────────────────────────────
    @classmethod
    def load(cls, config_path=None, root=None):
        """Build an Environment.

        ``config_path``: path to a config.toml, or an already-loaded Config, or
        None for the default location / built-in defaults.
        ``root``: explicit root override; otherwise derived from config's
        ``paths.home`` (``"~"`` => Path.home()).
        """
        if isinstance(config_path, Config):
            config = config_path
            cfg_file = None
        else:
            config = Config.load(config_path)
            cfg_file = config_path
        if root is not None:
            root_path = Path(root)
        else:
            home_t = config.home_template
            root_path = Path.home() if home_t == "~" else Path(home_t).expanduser()
        return cls(root_path, config, config_path=cfg_file)

    # ── Template resolution ─────────────────────────────────────────────
    def resolve(self, template):
        """Resolve a config path template against the root."""
        t = str(template)
        if t == "~":
            return self.root
        if t.startswith("~/"):
            return self.root / t[2:]
        p = Path(t)
        return p if p.is_absolute() else self.root / t

    # ── Standard derived paths ──────────────────────────────────────────
    @property
    def agent_map(self):
        return self.root / "agent_map.md"

    @property
    def workspace(self):
        return self.root / "workspace"

    @property
    def rooms(self):
        return self.root / "rooms"

    @property
    def data_dir(self):
        return self.root / "data"

    @property
    def obsidian(self):
        return self.root / "Obsidian"

    @property
    def skills_dir(self):
        return self.resolve(self.config.skills_dir_template)

    @property
    def state_dir(self):
        return self.resolve(self.config.state_dir_template)

    @property
    def version_file(self):
        return self.state_dir / "version"

    @property
    def logs_dir(self):
        """Daemon log directory (``~/.agent-env/logs``)."""
        return self.state_dir / "logs"

    @property
    def watcher_pidfile(self):
        """Pidfile for the self-daemonizing beacon watcher (decision: state in
        ``~/.agent-env``)."""
        return self.state_dir / "watcher.pid"

    @property
    def watcher_log(self):
        """Where the daemonized watcher redirects stdout/stderr."""
        return self.logs_dir / "watcher.log"

    @property
    def archive_dir(self):
        return self.root / "archive"

    @property
    def downloads_dir(self):
        return self.root / "Downloads"

    @property
    def home_str(self):
        """The root as it should appear in generated beacon text."""
        return str(self.root)

    # ── Resolved collections ────────────────────────────────────────────
    def watch_paths(self):
        return [self.resolve(p) for p in self.config.watch_paths]


def parse_config_arg(argv):
    """Pull ``--config PATH`` / ``--config=PATH`` out of ``argv``.

    Returns ``(config_path_or_None, remaining_argv)`` so a module's main() can
    do ``cfg, argv = parse_config_arg(sys.argv[1:])`` and keep parsing its own
    flags from the remainder.
    """
    config_path = None
    remaining = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--config":
            if i + 1 >= len(argv):
                raise SystemExit("--config requires a path argument")
            config_path = argv[i + 1]
            i += 2
            continue
        if arg.startswith("--config="):
            config_path = arg[len("--config="):]
            i += 1
            continue
        remaining.append(arg)
        i += 1
    return config_path, remaining
