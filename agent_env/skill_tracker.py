#!/usr/bin/env python3
"""
skill_tracker.py — Lightweight skill usage tracker.

Appends a timestamp to ~/.agents/skills/_usage_log.jsonl whenever a skill
is invoked, then rebuilds room indexes with usage stats.

Usage:
  python -m agent_env.skill_tracker log <skill_name>   # Log a skill invocation
  python -m agent_env.skill_tracker stats               # Print usage stats
  python -m agent_env.skill_tracker rebuild              # Rebuild room indexes with usage
  python -m agent_env.skill_tracker --config PATH ...     # use a specific config.toml
"""

import json
import sys
import time
from datetime import datetime

from agent_env.environment import Environment, parse_config_arg

# Rolling window for "recent" usage
RECENT_DAYS = 30


def log_usage(env, skill_name):
    """Append a usage timestamp for a skill."""
    skills_dir = env.skills_dir
    skills_dir.mkdir(parents=True, exist_ok=True)
    entry = {
        "skill": skill_name,
        "timestamp": datetime.now().isoformat(),
        "epoch": time.time(),
    }
    with open(skills_dir / "_usage_log.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"  Logged usage: {skill_name}")


def get_usage_stats(env):
    """Return dict of skill_name -> {total, recent, last_used} from the log."""
    stats = {}
    usage_log = env.skills_dir / "_usage_log.jsonl"
    if not usage_log.exists():
        return stats

    cutoff = time.time() - (RECENT_DAYS * 86400)

    with open(usage_log, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            skill = entry.get("skill", "")
            epoch = entry.get("epoch", 0)

            if skill not in stats:
                stats[skill] = {"total": 0, "recent": 0, "last_used": 0}

            stats[skill]["total"] += 1
            if epoch >= cutoff:
                stats[skill]["recent"] += 1
            if epoch > stats[skill]["last_used"]:
                stats[skill]["last_used"] = epoch

    return stats


def print_stats(env):
    """Print usage stats to stdout."""
    stats = get_usage_stats(env)
    if not stats:
        print("No usage data yet.")
        return

    print(f"\nSkill Usage Statistics (last {RECENT_DAYS} days)\n")
    print(f"{'Skill':<40} {'Total':>5} {'Recent':>6} {'Last Used':>12}")
    print("-" * 65)

    for skill, s in sorted(stats.items(), key=lambda x: x[1]["last_used"], reverse=True):
        last = datetime.fromtimestamp(s["last_used"]).strftime("%Y-%m-%d") if s["last_used"] else "never"
        print(f"{skill:<40} {s['total']:>5} {s['recent']:>6} {last:>12}")

    # Count skills with zero recent usage
    all_skills = set()
    skills_dir = env.skills_dir
    if skills_dir.exists():
        for d in skills_dir.iterdir():
            if d.is_dir() and (d / "SKILL.md").exists():
                all_skills.add(d.name)

    unused = all_skills - set(stats.keys())
    stale = {k: v for k, v in stats.items() if v["recent"] == 0}
    print(f"\n{len(unused)} skills never invoked")
    print(f"{len(stale)} skills not used in {RECENT_DAYS} days")


def rebuild_room_indexes(env):
    """Rebuild room indexes with usage stats included. Returns the number of
    room indexes updated (import entry point used by beacon_sync)."""
    stats = get_usage_stats(env)
    updated = 0

    rooms_dir = env.rooms
    if not rooms_dir.exists():
        print("  No rooms/ directory found")
        return updated

    for room_dir in rooms_dir.iterdir():
        if not room_dir.is_dir():
            continue

        index_path = room_dir / "skills_index.md"
        if not index_path.exists():
            continue

        # Re-read and reconstruct
        content = index_path.read_text(encoding="utf-8", errors="replace")
        lines = content.split("\n")
        new_lines = []
        in_table = False
        header_done = False

        for line in lines:
            stripped = line.strip()

            # Detect header row
            if stripped.startswith("|") and "Skill" in stripped and "Description" in stripped:
                # Clean up and rebuild with 3 columns
                new_lines.append("| Skill | Description | Last Used |")
                in_table = True
                header_done = False
                continue

            # Handle separator row
            if in_table and not header_done and stripped.startswith("|") and all(c in "|-: " for c in stripped):
                new_lines.append("|-------|-------------|-----------|")
                header_done = True
                continue

            # Handle data rows
            if in_table and header_done and stripped.startswith("|"):
                parts = [p.strip() for p in stripped.split("|")]
                parts = [p for p in parts if p]  # remove empty from leading/trailing |

                if len(parts) >= 2:
                    skill_name = parts[0].strip("`")
                    description = parts[1] if len(parts) > 1 else "(see SKILL.md for details)"
                    usage = stats.get(skill_name, {})
                    last_used = usage.get("last_used", 0)
                    if last_used:
                        last_date = datetime.fromtimestamp(last_used).strftime("%Y-%m-%d")
                    else:
                        last_date = "never"
                    new_lines.append(f"| {skill_name} | {description} | {last_date} |")
                elif len(parts) == 1:
                    # Malformed row — skip
                    continue
                else:
                    new_lines.append(line)
                continue

            # Non-table line
            if in_table and not stripped.startswith("|") and stripped:
                in_table = False

            if not in_table:
                # Check if this line has an old "Last Used" column to strip from non-table lines
                new_lines.append(line)

        new_content = "\n".join(new_lines)
        if new_content.strip() != content.strip():
            index_path.write_text(new_content, encoding="utf-8")
            print(f"  Updated {room_dir.name}/skills_index.md with usage data")
            updated += 1
        else:
            print(f"  {room_dir.name}/skills_index.md unchanged")

    return updated


def main():
    config_path, argv = parse_config_arg(sys.argv[1:])
    env = Environment.load(config_path)

    if not argv:
        print("Usage: skill_tracker.py [log <name> | stats | rebuild]")
        sys.exit(1)

    command = argv[0]

    if command == "log":
        if len(argv) < 2:
            print("Usage: skill_tracker.py log <skill_name>")
            sys.exit(1)
        log_usage(env, argv[1])
    elif command == "stats":
        print_stats(env)
    elif command == "rebuild":
        rebuild_room_indexes(env)
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()
