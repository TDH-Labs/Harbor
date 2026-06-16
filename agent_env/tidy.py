#!/usr/bin/env python3
"""
tidy.py — Optional, destructive home-directory hygiene.

These tasks modify the filesystem beyond regenerating beacons: archiving old
downloads, deleting stray __pycache__/node_modules, removing/archiving known
debris files, flagging stray home directories, and pruning empty archive dirs.

They are OFF by default (decision #7). beacon_sync's full sync only runs them
when ``tidy.enabled = true`` in config. Running ``python -m agent_env.tidy``
directly ALSO refuses under the default config: it executes only when
``tidy.enabled = true`` or an explicit ``--force`` flag is passed, so the
default config can never delete anything through any entry point. Whitelists
and the stray-file list come from config, so no personal filenames are
hardcoded here.

Usage:
  python -m agent_env.tidy [--config PATH] [--force]
"""

import sys

from agent_env import beacon_sync
from agent_env.environment import Environment, parse_config_arg


def archive_old_downloads(env):
    """Move files older than the configured cutoff from ~/Downloads/ to ~/archive/downloads/."""
    downloads_dir = env.downloads_dir
    if not downloads_dir.exists():
        return 0

    archive_dest = env.archive_dir / "downloads"
    archive_dest.mkdir(parents=True, exist_ok=True)

    import time
    cutoff = time.time() - (env.config.downloads_archive_days * 86400)
    moved = 0

    for f in downloads_dir.iterdir():
        if f.name.startswith("."):
            continue
        if f.name in {".DS_Store", ".localized"}:
            continue
        try:
            mtime = f.stat().st_mtime
        except OSError:
            continue
        if mtime < cutoff:
            dest = archive_dest / f.name
            # Handle name collisions
            if dest.exists():
                stem = f.stem
                suffix = f.suffix
                counter = 1
                while dest.exists():
                    dest = archive_dest / f"{stem}_{counter}{suffix}"
                    counter += 1
            import shutil
            try:
                shutil.move(str(f), str(dest))
                print(f"  Archived: Downloads/{f.name} → archive/downloads/{dest.name}")
                moved += 1
            except (OSError, shutil.Error) as e:
                print(f"  WARNING: Could not move {f.name}: {e}")

    return moved


def clean_pycache_home(env):
    """Remove __pycache__/ directories from the root (first level only)."""
    removed = 0
    pycache = env.root / "__pycache__"
    if pycache.exists() and pycache.is_dir():
        import shutil
        try:
            shutil.rmtree(str(pycache))
            print("  Removed: ~/__pycache__/")
            removed += 1
        except OSError as e:
            print(f"  WARNING: Could not remove ~/__pycache__/: {e}")
    return removed


def clean_node_modules_home(env):
    """Remove ~/node_modules/ if it exists (should never be at home level)."""
    nm = env.root / "node_modules"
    if nm.exists() and nm.is_dir():
        import shutil
        try:
            shutil.rmtree(str(nm))
            print("  Removed: ~/node_modules/")
            return 1
        except OSError as e:
            print(f"  WARNING: Could not remove ~/node_modules/: {e}")
            return 0
    return 0


def clean_stray_files(env):
    """Remove/archive known debris files from the root (from config.tidy.stray_files)."""
    removed = 0
    for name, action in env.config.stray_files.items():
        f = env.root / name
        if f.exists():
            if action == "archive":
                env.archive_dir.mkdir(parents=True, exist_ok=True)
                dest = env.archive_dir / name
                import shutil
                try:
                    shutil.move(str(f), str(dest))
                    print(f"  Archived: ~/{name} → archive/{name}")
                    removed += 1
                except (OSError, shutil.Error):
                    pass
            else:
                try:
                    f.unlink()
                    print(f"  Removed: ~/{name}")
                    removed += 1
                except OSError:
                    pass
    return removed


def flag_stray_home_dirs(env):
    """Report directories in the root that aren't in the whitelist and aren't recognized projects."""
    flagged = 0
    whitelist = env.config.home_whitelist
    for entry in env.root.iterdir():
        name = entry.name
        # Skip whitelisted
        if name in whitelist:
            continue
        # Skip hidden files/dirs (dotfiles)
        if name.startswith("."):
            continue
        # Skip if it's a recognized project (has project signatures)
        if entry.is_dir() and beacon_sync.is_project_dir(env, entry):
            continue
        # Flag unrecognized directories
        if entry.is_dir():
            # Check if it's something we should know about
            size = sum(f.stat().st_size for f in entry.rglob("*") if f.is_file()) if entry.is_dir() else 0
            size_mb = size / (1024 * 1024)
            print(f"  STRAY DIR: ~/{name}/ ({size_mb:.1f} MB) — not in workspace or whitelist")
            flagged += 1

    return flagged


def clean_empty_dirs_in_archive(env):
    """Remove empty subdirectories from ~/archive/."""
    removed = 0
    archive_dir = env.archive_dir
    if not archive_dir.exists():
        return 0
    for subdir in sorted(archive_dir.rglob("*"), reverse=True):
        if subdir.is_dir() and not any(subdir.iterdir()):
            try:
                subdir.rmdir()
                print(f"  Removed empty archive dir: {subdir.relative_to(env.root)}")
                removed += 1
            except OSError:
                pass
    return removed


def run_tidy(env):
    """Run all destructive hygiene tasks. Returns the number of changes made."""
    changes = 0
    changes += archive_old_downloads(env)
    changes += clean_pycache_home(env)
    changes += clean_node_modules_home(env)
    changes += clean_stray_files(env)
    changes += flag_stray_home_dirs(env)
    changes += clean_empty_dirs_in_archive(env)
    return changes


def main():
    config_path, argv = parse_config_arg(sys.argv[1:])
    env = Environment.load(config_path)

    # Destructive hygiene is gated: refuse under the default config unless the
    # user opts in via tidy.enabled or an explicit --force (decision #7). This
    # keeps the default config from deleting anything via ANY entry point.
    force = "--force" in argv
    if not env.config.tidy_enabled and not force:
        print("Refusing to run: tidy is disabled (tidy.enabled = false).")
        print("Enable it in config (tidy.enabled = true) or pass --force to override.")
        sys.exit(2)

    print("Running tidy (destructive hygiene)...")
    changes = run_tidy(env)
    print(f"Tidy: {changes} changes made." if changes else "Tidy: all clean, no changes needed.")


if __name__ == "__main__":
    main()
