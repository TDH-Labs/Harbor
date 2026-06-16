#!/usr/bin/env python3
"""
migrate.py — Schema migration for agent_map.md.

Detects the schema version from the map's leading stamp comment, backs the
map up to ``~/.agent-env/backups/`` before any change, transforms ONLY known
sections, NEVER touches free-form sections, and bumps the stamp.

Supported transitions
---------------------
v0 → 1.0   Pre-stamp map (no ``<!-- agent-env schema: … -->`` line).
            Adds the schema stamp and expands "3-layer" references to "5-layer".
1.0 → 1.0  Already current — no-op (idempotent).

Design rules
------------
- Back up first, transform second.  The backup is a timestamped copy so
  multiple runs produce distinct archives, never overwrite each other.
- Never touch free-form sections (anything after the last known table).
  Only the first line (stamp) and targeted wording replacements are modified.
- Running migrate twice on an already-current map is always a no-op.
"""

from __future__ import annotations

import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

from agent_env.environment import Environment, parse_config_arg

CURRENT_SCHEMA = "1.0"
STAMP_PATTERN = re.compile(r"<!--\s*agent-env schema:\s*(\S+)\s*-->")
STAMP_LINE = f"<!-- agent-env schema: {CURRENT_SCHEMA} -->\n"


# ── public API ────────────────────────────────────────────────────────────────

def detect_version(map_text: str) -> str:
    """Return the schema version from the map stamp, or '0' if absent."""
    first_line = map_text.splitlines()[0] if map_text else ""
    m = STAMP_PATTERN.match(first_line.strip())
    return m.group(1) if m else "0"


def backup_map(map_path: Path, backups_dir: Path) -> Path:
    """Copy *map_path* into *backups_dir* with a timestamp suffix.

    Returns the backup path.  Creates *backups_dir* if absent.
    Raises ``FileNotFoundError`` if *map_path* does not exist.
    """
    if not map_path.exists():
        raise FileNotFoundError(f"agent_map.md not found: {map_path}")
    backups_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
    dest = backups_dir / f"agent_map.{ts}.md"
    shutil.copy2(map_path, dest)
    return dest


def transform_v0_to_v1(text: str) -> str:
    """Transform a v0 (pre-stamp) map to schema 1.0.

    Changes made (ONLY in these targeted patterns):
    - Inserts the schema stamp as the first line.
    - Replaces "3-layer" with "5-layer" in the architectural overview section.
    - Does NOT touch any other free-form section.
    """
    # Remove any existing (possibly malformed) stamp line before prepending.
    if STAMP_PATTERN.match(text.splitlines()[0].strip() if text else ""):
        text = text[text.index("\n") + 1:]

    # Targeted text replacement — only well-known patterns.
    text = text.replace("3-layer structure", "5-layer structure")
    text = text.replace("3-layer workspace", "5-layer workspace")

    return STAMP_LINE + text


def migrate(env: Environment, *, dry_run: bool = False) -> dict:
    """Run schema migration on *env*'s agent_map.md.

    Returns a result dict::

        {
            "version_before": "0" | "1.0",
            "version_after":  "1.0",
            "backup":         Path | None,  # None on no-op
            "changed":        bool,
            "dry_run":        bool,
        }

    Idempotent: if the map is already at CURRENT_SCHEMA, returns immediately
    with ``changed=False``.
    """
    map_path = env.root / "agent_map.md"
    backups_dir = env.state_dir / "backups"

    if not map_path.exists():
        raise FileNotFoundError(f"agent_map.md not found at {map_path}")

    original = map_path.read_text(encoding="utf-8")
    version = detect_version(original)

    result = {
        "version_before": version,
        "version_after": CURRENT_SCHEMA,
        "backup": None,
        "changed": False,
        "dry_run": dry_run,
    }

    if version == CURRENT_SCHEMA:
        # Already current — no-op.
        return result

    if version == "0":
        transformed = transform_v0_to_v1(original)
    else:
        raise ValueError(
            f"Unknown schema version {version!r} — cannot migrate automatically. "
            f"Please check the agent_map.md stamp."
        )

    if transformed == original:
        return result

    result["changed"] = True

    if not dry_run:
        result["backup"] = backup_map(map_path, backups_dir)
        map_path.write_text(transformed, encoding="utf-8")

    return result


# ── CLI entry point ───────────────────────────────────────────────────────────

def main():
    config_path, argv = parse_config_arg(sys.argv[1:])
    dry_run = "--dry-run" in argv

    env = Environment.load(config_path)
    try:
        result = migrate(env, dry_run=dry_run)
    except (FileNotFoundError, ValueError) as exc:
        print(f"migrate: error — {exc}", file=sys.stderr)
        sys.exit(1)

    if not result["changed"]:
        print(
            f"migrate: map is already at schema {result['version_after']} — nothing to do."
        )
        sys.exit(0)

    verb = "Would transform" if dry_run else "Transformed"
    print(
        f"migrate: {verb} schema {result['version_before']} → {result['version_after']}"
    )
    if result["backup"]:
        print(f"  backup: {result['backup']}")
    sys.exit(0)


if __name__ == "__main__":
    main()
