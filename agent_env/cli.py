#!/usr/bin/env python3
"""
cli.py — the ``agent-env`` console entry point.

A thin argparse dispatcher over the existing module functions. Every subcommand
is a *wrapper*: the real work stays in beacon_sync / beacon_watcher / new_project
/ tidy, and the per-module ``python -m agent_env.<module>`` entry points keep
working unchanged (decision #2). This module only adds the unifying surface plus
three things that have no natural home in the existing modules:

* ``setup``    — build the directory tree from config, record every created path
                 in a manifest, run an initial sync, then verify with ``check``.
* ``teardown`` — remove ONLY manifest-listed paths, prompting before deleting
                 anything the user has since modified, and never touching a path
                 that is not in the manifest.
* ``check``    — a read-only health report (config, map tables, beacon freshness,
                 version stamp, fswatch availability, broken symlinks).

Subcommands::

    agent-env setup        --root DIR | --config FILE   # build + verify an env
    agent-env init                                       # stub (Phase 5)
    agent-env sync         [--generate-only]             # beacon_sync.full_sync
    agent-env watch        [--poll]                      # foreground watcher
    agent-env start        [--poll]                      # daemonize the watcher
    agent-env stop                                       # stop the daemon
    agent-env new-project  NAME [--room R] [--source S]  # new_project
    agent-env check                                      # read-only health report
    agent-env teardown     --root DIR | --config FILE    # remove what setup made
    agent-env tidy         [--force]                     # gated destructive hygiene
    agent-env migrate                                    # migrate map schema

Target selection (``--root`` / ``--config``)
--------------------------------------------
Every command resolves its environment from either ``--config FILE`` (read that
config.toml; its ``paths.home`` fixes the root) or ``--root DIR`` (use built-in
defaults, rooted at DIR). ``--root`` deliberately does NOT read the
default-location ``~/.agent-env/config.toml`` — a bare root must never pull in a
live machine's real config. ``setup`` and ``teardown`` *require* one of the two:
they refuse to fall back to the default location, so they can never run against a
real ``$HOME`` by accident.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

from agent_env import beacon_sync, beacon_watcher, mdtables, new_project, tidy
from agent_env.config import SCHEMA_VERSION, Config, ConfigError
from agent_env.environment import Environment

MANIFEST_NAME = "manifest.json"

STUB_COMMANDS: set = set()  # No more stubs — migrate is implemented.


# A generic starter map written by ``setup`` when no agent_map.md exists yet (the
# full onboarding interview that authors a real map is Phase 5's ``init``). It is
# deliberately personal-data-free and has valid Room/Project tables so the
# initial sync and the follow-up ``check`` both pass on a clean tmp root.
SEED_AGENT_MAP = """\
# Agent Core Map & Routing Protocol

> The single source of truth for this environment. Edit this file; every beacon
> regenerates from it. Run `agent-env init` (Phase 5) for a guided setup.

## Architectural Overview

This environment uses a 5-layer structure for agent context.

## Available Rooms

| Room | Path | Purpose |
|------|------|---------|
| General | ~/rooms/general/ | Default workspace for uncategorized work |

## Active Projects

| Project | Path | Status |
|---------|------|--------|

## Core Directives

1. Never ingest raw data directly into your primary context window.
2. Never traverse outside the environment root unless explicitly asked.
3. Use the compaction workflow: research.md -> plan.md -> execute from the plan.

## Security

- Root scope: the environment root -- all file operations must resolve within this prefix.
"""


# ── Environment construction ────────────────────────────────────────────────

def build_env(args):
    """Resolve an Environment from ``--config`` / ``--root``.

    With ``--root`` but no ``--config`` we build from the *built-in defaults*
    rather than ``Config.load(None)`` — the latter would read the real
    ``~/.agent-env/config.toml`` on a live machine, which this phase must never
    touch. With ``--config`` we read exactly that file.
    """
    config_path = getattr(args, "config", None)
    root = getattr(args, "root", None)
    if config_path is None and root is not None:
        return Environment.load(Config.defaults(), root=root)
    return Environment.load(config_path, root=root)


# ── check: read-only health report ──────────────────────────────────────────

class CheckReport:
    """Collected findings from ``run_check``: errors fail the check, warnings do
    not. ``ok`` is true iff there are no errors."""

    def __init__(self):
        self.errors = []
        self.warnings = []
        self.infos = []

    @property
    def ok(self):
        return not self.errors

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    def info(self, msg):
        self.infos.append(msg)


def _cells(line):
    """Split a markdown table row into its non-empty cells."""
    parts = [p.strip() for p in line.strip().split("|")]
    return [p for p in parts if p]


def validate_agent_map(content):
    """Return a list of human-readable problems with the map's tables.

    ``mdtables.parse_table`` silently drops ragged rows so generation never
    crashes; ``check`` needs the opposite, so this re-walks the Rooms and
    Projects tables and reports a missing table or any row whose column count
    does not match the header.
    """
    problems = []
    lines = content.split("\n")
    for label, headers in (("Rooms", ("Room", "Path")),
                           ("Projects", ("Project", "Path"))):
        header_idx, last_idx = mdtables.find_table_bounds(lines, *headers)
        if header_idx is None:
            problems.append(f"{label} table not found")
            continue
        header_cols = len(_cells(lines[header_idx]))
        for i in range(header_idx + 1, last_idx + 1):
            cells = _cells(lines[i])
            if not cells:
                continue
            if all(set(c) <= {"-", ":"} for c in cells):
                continue  # separator row
            if len(cells) != header_cols:
                problems.append(
                    f"malformed row in {label} table: {lines[i].strip()!r} "
                    f"({len(cells)} cols, expected {header_cols})"
                )
    return problems


def _broken_symlinks(env):
    """Symlinks under workspace/ or the skills pool whose target is missing."""
    out = []
    for base in (env.workspace, env.skills_dir):
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if p.is_symlink() and not p.resolve().exists():
                out.append(p)
    return out


def run_check(env):
    """Validate the environment and return a :class:`CheckReport` (read-only).

    Checks: config validity (the Environment only builds from a valid config),
    agent_map.md table well-formedness, the schema-version stamp (state-dir file
    and map comment), beacon freshness against the map's mtime, fswatch
    availability, and broken symlinks.
    """
    report = CheckReport()
    report.info(f"config valid (schema {env.config.schema_version})")

    map_path = env.agent_map
    content = ""
    if not map_path.exists():
        report.error(f"agent_map.md not found at {map_path}")
    else:
        content = map_path.read_text()
        if not content.strip():
            report.error("agent_map.md is empty")
        else:
            for problem in validate_agent_map(content):
                report.error(f"agent_map.md: {problem}")

    # Version stamp: the state-dir file and the in-map comment.
    version_file = env.version_file
    expected = env.config.schema_version
    if not version_file.exists():
        report.error(f"version stamp missing ({version_file})")
    else:
        stamped = version_file.read_text().strip()
        if stamped != expected:
            report.error(f"version stamp mismatch: {stamped!r} != {expected!r}")
    if content.strip() and "<!-- agent-env schema:" not in content:
        report.error("agent_map.md is missing its schema-version comment")

    # Beacon freshness: every home beacon must exist and be at least as new as
    # the map it is generated from.
    if map_path.exists():
        map_mtime = map_path.stat().st_mtime
        for target in env.config.home_beacon_targets:
            beacon = env.root / target
            if not beacon.exists():
                report.error(f"beacon {target} missing")
            elif beacon.stat().st_mtime < map_mtime:
                report.error(f"beacon {target} is stale (older than agent_map.md)")
            elif not beacon.is_symlink():
                content_check = beacon.read_text()
                if beacon_sync.BEACON_STAMP not in content_check:
                    report.warn(
                        f"beacon {target} lacks agent-env sync stamp — "
                        "another tool may have regenerated this file"
                    )

    # fswatch is optional — its absence only downgrades the watcher to polling.
    if shutil.which("fswatch"):
        report.info("fswatch available")
    else:
        report.warn("fswatch not on PATH — watcher will use the 5s polling fallback")

    for broken in _broken_symlinks(env):
        report.warn(f"broken symlink: {broken}")

    return report


def print_report(report):
    for msg in report.infos:
        print(f"  ok    {msg}")
    for msg in report.warnings:
        print(f"  warn  {msg}")
    for msg in report.errors:
        print(f"  ERROR {msg}")
    print(
        f"\ncheck: {'PASS' if report.ok else 'FAIL'} "
        f"({len(report.errors)} error(s), {len(report.warnings)} warning(s))"
    )


# ── setup: build the tree + record a manifest ───────────────────────────────

def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def snapshot(base):
    """Set of every path under ``base`` (the base itself, dirs, files, symlinks).

    Symlinked directories are recorded but not descended into (``followlinks``
    off), so a project's ``project/`` symlink never drags an external tree into
    the manifest. Returns an empty set when ``base`` does not exist.
    """
    seen = set()
    base = Path(base)
    if not base.exists():
        return seen
    seen.add(base)
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        dp = Path(dirpath)
        for name in dirnames:
            seen.add(dp / name)
        for name in filenames:
            seen.add(dp / name)
    return seen


def _rel(env, path):
    """Path string relative to the root when under it, else the absolute path."""
    try:
        return str(Path(path).relative_to(env.root))
    except ValueError:
        return str(path)


def _abs(env, stored):
    """Inverse of :func:`_rel`: resolve a stored manifest path under the root."""
    p = Path(stored)
    return p if p.is_absolute() else env.root / p


def _entry_for(env, path):
    """Manifest record for a created path. Symlinks are checked before dirs (a
    symlink to a dir reports ``is_dir``); only regular files carry a hash, used
    later to detect user modification before teardown deletes them."""
    rel = _rel(env, path)
    if path.is_symlink():
        return {"path": rel, "type": "symlink"}
    if path.is_dir():
        return {"path": rel, "type": "dir"}
    return {"path": rel, "type": "file", "sha256": _sha256(path)}


def create_tree(env):
    """Create the standard 5-layer directory skeleton from config."""
    for d in (env.root, env.workspace, env.rooms, env.data_dir, env.obsidian,
              env.state_dir, env.skills_dir):
        d.mkdir(parents=True, exist_ok=True)


def write_seed_map(env):
    """Write the generic seed agent_map.md if none exists. Returns whether it
    wrote one (an existing map — e.g. from a future ``init`` — is left alone)."""
    if env.agent_map.exists():
        return False
    env.agent_map.write_text(SEED_AGENT_MAP)
    return True


def manifest_path(env):
    return env.state_dir / MANIFEST_NAME


def read_manifest(env):
    mp = manifest_path(env)
    if not mp.exists():
        return None
    return json.loads(mp.read_text())


def write_manifest(env, manifest):
    env.state_dir.mkdir(parents=True, exist_ok=True)
    manifest_path(env).write_text(json.dumps(manifest, indent=2) + "\n")


def setup_env(env, *, verify=True):
    """Build the environment and record everything created in a manifest.

    Snapshots the root before and after building, so the manifest captures EVERY
    path that setup (and the initial sync it runs) created — not just the ones
    this function writes directly. Returns a dict with the manifest, the created
    paths, and the verifying :class:`CheckReport` (``None`` when ``verify`` is
    off).
    """
    before = snapshot(env.root)
    create_tree(env)
    wrote_map = write_seed_map(env)
    beacon_sync.full_sync(env)
    after = snapshot(env.root)

    created = sorted(after - before, key=lambda p: len(p.parts))
    entries = [_entry_for(env, p) for p in created]
    manifest = {
        "schema_version": env.config.schema_version,
        "root": str(env.root),
        "created": entries,
    }
    write_manifest(env, manifest)

    report = run_check(env) if verify else None
    return {"manifest": manifest, "created": created,
            "check": report, "wrote_map": wrote_map}


# ── teardown: remove exactly what the manifest lists ─────────────────────────

def _interactive_confirm(path, reason):
    resp = input(f"  {path} was {reason} since setup — delete anyway? [y/N] ")
    return resp.strip().lower() in ("y", "yes")


def _under(path, base):
    try:
        Path(path).relative_to(base)
        return True
    except ValueError:
        return False


def _within_root(path, real_root):
    """True iff *path*'s own filesystem location resolves inside *real_root*.

    ``relative_to`` is purely lexical, so ``root/../evil`` "passes" it while
    physically escaping — that was F1. This resolves the real location instead:
    the parent directory is resolved through symlinks (``os.path.realpath``) but
    the final component is NOT, so a symlink entry is judged by where the link
    *lives*, never by where it points (unlinking a symlink never touches its
    target). *real_root* must already be ``os.path.realpath``-resolved.
    """
    p = Path(path)
    located = os.path.join(os.path.realpath(p.parent), p.name)
    return located == real_root or located.startswith(real_root + os.sep)


def teardown_env(env, *, confirm=None):
    """Remove only the paths the manifest recorded, prompting on user edits.

    Guarantees (the reviewer gate): a path absent from the manifest is never
    deleted; a manifest file whose hash no longer matches is deleted only after
    ``confirm`` returns true; a directory that now holds unmanaged content is
    left in place (so a planted, unmanaged file always survives). The manifest,
    then the state dir, are removed last.

    Path safety is two-layered (F1): a lexical pre-flight refuses the whole
    operation if any entry is absolute or contains ``..``, and a realpath
    containment check (run again right before every unlink/rmdir, for files,
    dirs, and symlinks alike) refuses to touch anything whose resolved location
    falls outside the root. A tampered manifest therefore deletes nothing.

    ``confirm(path, reason) -> bool`` decides each user-modified file (default:
    interactive prompt; tests inject a callable). Returns a summary dict.
    """
    if confirm is None:
        confirm = _interactive_confirm
    manifest = read_manifest(env)
    if manifest is None:
        raise FileNotFoundError(
            f"no manifest at {manifest_path(env)} — nothing to tear down"
        )
    if manifest.get("root") != str(env.root):
        raise ValueError(
            f"manifest root {manifest.get('root')!r} does not match target "
            f"{str(env.root)!r}; refusing to tear down"
        )

    state_dir = env.state_dir
    real_root = os.path.realpath(env.root)

    # ── Path-safety pre-flight (defense in depth, F1) ───────────────────────
    # Both layers run BEFORE a single path is touched, so a tampered manifest
    # makes teardown delete nothing.
    #
    # Layer 1 — lexical hard-reject. setup only ever records paths relative to
    # and under the root, so any entry that is absolute or carries a ".."
    # component is tampering; refuse the whole operation.
    for entry in manifest["created"]:
        raw = entry["path"]
        if Path(raw).is_absolute() or ".." in Path(raw).parts:
            raise ValueError(
                f"manifest entry {raw!r} escapes the root "
                f"(absolute path or '..' component); refusing to tear down"
            )

    resolved = [(e, _abs(env, e["path"])) for e in manifest["created"]]

    # Layer 2 — resolve-then-contain. Realpath each entry's own location and
    # verify it stays inside the resolved root. Catches escapes a lexical check
    # cannot — e.g. a relative entry threaded through a parent that is itself a
    # symlink pointing outside the root.
    for entry, path in resolved:
        if not _within_root(path, real_root):
            raise ValueError(
                f"manifest path escapes the root after symlink resolution: "
                f"{path}; refusing to tear down"
            )

    removed, kept, missing = [], [], []

    def remove_file(entry, path):
        # Final containment gate, before ANY type dispatch and regardless of
        # whether the entry carries a hash — closes a TOCTOU swap that slips a
        # symlink in after the pre-flight pass (F1, defense in depth).
        if not _within_root(path, real_root):
            raise ValueError(
                f"refusing to unlink outside the root: {path}")
        if not (path.is_symlink() or path.exists()):
            missing.append(str(path))
            return
        if entry["type"] == "file" and "sha256" in entry:
            try:
                modified = _sha256(path) != entry["sha256"]
            except OSError:
                modified = True
            if modified and not confirm(path, "modified"):
                kept.append(str(path))
                return
        path.unlink()
        removed.append(str(path))

    def remove_dir(path):
        if not _within_root(path, real_root):
            raise ValueError(
                f"refusing to remove a directory outside the root: {path}")
        if not path.exists():
            missing.append(str(path))
            return
        if any(path.iterdir()):
            kept.append(str(path))  # holds unmanaged content — leave it
            return
        path.rmdir()
        removed.append(str(path))

    # Non-state paths first, then state-dir paths; files/symlinks before dirs,
    # dirs deepest-first so a parent is only removed once its managed children
    # are gone. The state dir itself is deferred to the final block, since the
    # manifest file living inside it is only removed after this loop.
    non_state = [(e, p) for e, p in resolved if not _under(p, state_dir)]
    state = [(e, p) for e, p in resolved if _under(p, state_dir)]
    for group in (non_state, state):
        for entry, path in group:
            if entry["type"] in ("file", "symlink"):
                remove_file(entry, path)
        dirs = [(e, p) for e, p in group
                if e["type"] == "dir" and p != state_dir]
        for entry, path in sorted(dirs, key=lambda ep: len(ep[1].parts),
                                  reverse=True):
            remove_dir(path)

    # The manifest itself, then the state dir, last.
    mp = manifest_path(env)
    if mp.exists():
        mp.unlink()
        removed.append(str(mp))
    if state_dir.exists():
        if any(state_dir.iterdir()):
            kept.append(str(state_dir))  # unmanaged content remains
        else:
            state_dir.rmdir()
            removed.append(str(state_dir))

    return {"removed": removed, "kept": kept, "missing": missing}


# ── Subcommand dispatch ─────────────────────────────────────────────────────

def do_setup(env, args):
    # --demo materializes demo content to a target root (tmp in tests,
    # ~/agent-env-demo/ in real runs) and then runs a full sync + check.
    demo_root = getattr(args, "demo", None)
    if demo_root is not None:
        return _do_setup_demo(Path(demo_root))

    result = setup_env(env)
    print(f"setup: created {len(result['created'])} paths under {env.root}")
    print(f"  manifest: {manifest_path(env)}")
    report = result["check"]
    print_report(report)
    return 0 if report.ok else 1


def _do_setup_demo(root: Path) -> int:
    """Materialize demo content to *root*, then run a full sync + check."""
    from agent_env import beacon_sync
    from agent_env.config import Config
    from agent_env.demo import materialize

    root = root.expanduser()
    real_root = os.path.realpath(root)
    real_home = os.path.realpath(Path.home())

    # Refuse if the demo root IS the real home or is an ancestor of it.
    # This blocks `~`, `~/..`, `/`, and symlink tricks regardless of how root
    # was spelled on the command line.
    # Note: startswith(root + sep) breaks for "/" because a real home does
    # not start with "//"; Path.is_relative_to() handles all cases correctly.
    if Path(real_home).is_relative_to(real_root):
        print(
            f"setup --demo: refusing — resolved root {real_root!r} is the real "
            f"home directory or an ancestor of it. Choose a path outside home, "
            f"e.g. /tmp/demo-env",
            file=__import__("sys").stderr,
        )
        return 1

    print(f"setup --demo: materializing demo environment under {root}")

    created = materialize(root)
    print(f"  created {len(created)} demo files")

    # Write a minimal config and run a full sync so `agent-env check` passes.
    state_dir = root / ".agent-env"
    state_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = state_dir / "config.toml"
    if not cfg_path.exists():
        cfg_text = (
            f'schema_version = "{SCHEMA_VERSION}"\n'
            f'\n[paths]\nhome = "{root}"\n'
            f'\n[discovery]\nscan_home = false\nskip_list = []\n'
            f'\n[beacons]\nhome_targets = ["AGENTS.md"]\n'
            f'\n[tidy]\nenabled = false\n'
        )
        cfg_path.write_text(cfg_text)

    cfg = Config.load(str(cfg_path))
    env = Environment(root, cfg, config_path=str(cfg_path))
    beacon_sync.full_sync(env)

    report = run_check(env)
    print_report(report)
    print("\nDemo environment ready. Explore with:")
    print(f"  cat {root}/agent_map.md")
    print(f"  cat {root}/Obsidian/_index.md")
    print(f"  cat {root}/data/catalog.md")
    return 0 if report.ok else 1


def do_init(env, args):
    """Run the Phase 5 onboarding interview to write config.toml + agent_map.md."""
    from agent_env import interview

    pre = None
    if getattr(args, "defaults", False):
        pre = {}
    elif getattr(args, "answers_file", None):
        import json
        try:
            with open(args.answers_file) as fh:
                pre = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"error: cannot load --from-answers file: {exc}", file=sys.stderr)
            return 2

    interview.run_interview(
        env.root,
        pre=pre,
        confirm_map=(pre is None),  # skip confirm when non-interactive
        sync=True,
    )
    return 0


def do_sync(env, args):
    if args.generate_only:
        beacon_sync.run_generate(env)
    else:
        beacon_sync.full_sync(env)
    return 0


def do_watch(env, args):
    beacon_watcher.run_foreground(env, force_poll=args.poll)
    return 0


def do_start(env, args):
    pid = beacon_watcher.start(env, force_poll=args.poll, config_path=args.config)
    print(f"watcher running (pid {pid})" if pid else "watcher failed to start")
    return 0 if pid else 1


def do_stop(env, args):
    print("watcher stopped" if beacon_watcher.stop(env) else "no running watcher")
    return 0


def do_new_project(env, args):
    new_project.create_workspace(env, args.name, room=args.room, source=args.source)
    return 0


def do_check(env, args):
    report = run_check(env)
    print_report(report)
    return 0 if report.ok else 1


def do_teardown(env, args):
    confirm = (lambda path, reason: True) if args.yes else _interactive_confirm
    result = teardown_env(env, confirm=confirm)
    print(f"teardown: removed {len(result['removed'])} paths")
    if result["kept"]:
        print(f"  kept {len(result['kept'])} (user-modified or non-empty):")
        for path in result["kept"]:
            print(f"    {path}")
    return 0


def do_tidy(env, args):
    # Destructive hygiene is gated exactly as agent_env.tidy.main is: refuse
    # unless config opts in or --force overrides (decision #7).
    if not env.config.tidy_enabled and not args.force:
        print("Refusing to run: tidy is disabled (tidy.enabled = false).")
        print("Enable it in config (tidy.enabled = true) or pass --force to override.")
        return 2
    changes = tidy.run_tidy(env)
    print(f"tidy: {changes} change(s) made." if changes
          else "tidy: all clean, no changes needed.")
    return 0


def do_migrate(env, args):
    from agent_env import migrate as _migrate
    dry_run = getattr(args, "dry_run", False)
    try:
        result = _migrate.migrate(env, dry_run=dry_run)
    except (FileNotFoundError, ValueError) as exc:
        print(f"migrate: error — {exc}", file=sys.stderr)
        return 1
    if not result["changed"]:
        print(f"migrate: map already at schema {result['version_after']} — nothing to do.")
        return 0
    verb = "Would transform" if dry_run else "Transformed"
    print(f"migrate: {verb} schema {result['version_before']} → {result['version_after']}")
    if result["backup"]:
        print(f"  backup: {result['backup']}")
    return 0


# ── Argument parser ─────────────────────────────────────────────────────────

def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", metavar="FILE",
                        help="path to a config.toml (its paths.home sets the root)")
    common.add_argument("--root", metavar="DIR",
                        help="environment root; uses built-in defaults (does not "
                             "read the default-location config)")

    parser = argparse.ArgumentParser(
        prog="agent-env",
        description="Turnkey 5-layer agent operating environment.",
        parents=[common],
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    def add(name, func, help_text, **kw):
        sp = sub.add_parser(name, parents=[common], help=help_text)
        sp.set_defaults(func=func)
        return sp

    p_setup = add("setup", do_setup, "build the environment from config and verify it")
    p_setup.add_argument(
        "--demo", metavar="ROOT",
        help="materialize a generic demo environment under ROOT (tmp in tests, "
             "~/agent-env-demo/ for real runs); independent of --root/--config",
    )

    p_init = add("init", do_init, "onboarding interview: write config.toml + agent_map.md")
    p_init.add_argument(
        "--from-answers", metavar="FILE", dest="answers_file",
        help="JSON file with pre-filled answers (non-interactive / automation)",
    )
    p_init.add_argument(
        "--defaults", action="store_true",
        help="use all defaults without prompting (non-interactive)",
    )

    p_sync = add("sync", do_sync, "discover + regenerate all beacons")
    p_sync.add_argument("--generate-only", action="store_true",
                        help="regenerate beacons without project discovery")

    p_watch = add("watch", do_watch, "run the beacon watcher in the foreground")
    p_watch.add_argument("--poll", action="store_true",
                         help="force the polling backend (skip fswatch)")

    p_start = add("start", do_start, "start the beacon watcher as a daemon")
    p_start.add_argument("--poll", action="store_true",
                         help="force the polling backend (skip fswatch)")

    add("stop", do_stop, "stop the running watcher daemon")

    p_np = add("new-project", do_new_project, "bootstrap a new project workspace")
    p_np.add_argument("name", help="project name")
    p_np.add_argument("--room", help="room to associate the project with")
    p_np.add_argument("--source", help="path to symlink as the project's source")

    add("check", do_check, "read-only health report")

    p_td = add("teardown", do_teardown, "remove exactly what setup created")
    p_td.add_argument("--yes", action="store_true",
                      help="assume yes to user-modified-file prompts")

    p_tidy = add("tidy", do_tidy, "destructive hygiene (gated; default off)")
    p_tidy.add_argument("--force", action="store_true",
                        help="run even when tidy.enabled is false")

    p_mig = add("migrate", do_migrate,
                "migrate agent_map.md to the current schema version")
    p_mig.add_argument("--dry-run", action="store_true",
                       help="show what would change without writing anything")

    return parser


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(argv)

    if not getattr(args, "command", None):
        parser.print_help()
        return 2

    # setup/teardown must never fall back to the default location (the real
    # ~/.agent-env / $HOME on a live machine): require an explicit target.
    # Exception: `setup --demo ROOT` has its own target and bypasses this.
    _has_demo = args.command == "setup" and getattr(args, "demo", None)
    if args.command in ("setup", "teardown") and not (args.config or args.root or _has_demo):
        print(f"error: '{args.command}' requires an explicit --root DIR or "
              f"--config FILE (it will not operate on the default location)",
              file=sys.stderr)
        return 2

    if args.command in STUB_COMMANDS:
        return args.func(None, args)

    # `setup --demo ROOT` is self-contained: no Environment needed.
    if _has_demo:
        return args.func(None, args)

    try:
        if args.command == "init" and not args.config and not args.root:
            # `agent-env init` with no flags: default to real home with built-in
            # defaults.  Tests always pass --root; production users run bare init.
            from pathlib import Path as _Path

            from agent_env.config import Config as _Config
            env = Environment.load(_Config.defaults(), root=_Path.home())
        else:
            env = build_env(args)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    return args.func(env, args)


if __name__ == "__main__":
    sys.exit(main())
