#!/usr/bin/env python3
"""
new_project.py — Bootstrap a new project workspace with zero manual work.

Usage:
  python -m agent_env.new_project <project-name> [--room <room-name>] [--source <path>] [--config PATH]

Creates:
  <workspace>/<project-name>/
  ├── AGENTS.md          (symlink to the home AGENTS.md beacon)
  ├── research.md
  ├── plan.md
  ├── scratchpad.md
  └── project/           (symlink to --source if provided)

Then updates agent_map.md with the new project entry and re-runs beacon_sync.

Examples:
  python -m agent_env.new_project my-research-project
  python -m agent_env.new_project quarterly-model --room finance_real_estate --source ~/code/quarterly-model
"""

import os
import re
import sys

from agent_env import beacon_sync, mdtables
from agent_env.environment import Environment, parse_config_arg


def slugify(name):
    """Convert project name to directory-safe slug."""
    slug = name.lower().strip()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug


def create_workspace(env, name, room=None, source=None):
    slug = slugify(name)
    project_dir = env.workspace / slug

    if project_dir.exists():
        print(f"ERROR: {project_dir} already exists. Choose a different name or use the existing workspace.")
        sys.exit(1)

    project_dir.mkdir(parents=True, exist_ok=True)
    print(f"Created {project_dir}/")

    # Create compaction files
    for compaction in ["research.md", "plan.md", "scratchpad.md"]:
        path = project_dir / compaction
        path.write_text(f"# {compaction.replace('.md', '').title()}\n\n# {name}\n\n")
        print(f"  Created {path}")

    # Create symlink to source if provided
    if source:
        source = os.path.expanduser(source)
        if not os.path.exists(source):
            print(f"  WARNING: Source path {source} does not exist, creating symlink anyway")
        link_path = project_dir / "project"
        os.symlink(source, str(link_path))
        print(f"  Linked project/ → {source}")

    # Create AGENTS.md as symlink to home-level beacon (single source of truth)
    home_beacon = env.root / "AGENTS.md"
    os.symlink(str(home_beacon), str(project_dir / "AGENTS.md"))
    print(f"  Symlinked AGENTS.md → {home_beacon}")

    # Update agent_map.md
    update_agent_map(env, slug, name, room, source)

    # Re-run beacon_sync to propagate changes (imported, no subprocess)
    print("\nRunning beacon_sync to propagate changes...")
    beacon_sync.full_sync(env)

    print(f"\nProject '{name}' is ready at {project_dir}/")
    print("All beacon files have been updated.")


def update_agent_map(env, slug, name, room, source):
    content = beacon_sync.read_file(env.agent_map)

    # Add the new project to the Active Projects table (shared mdtables logic).
    new_row = f"| {name} | `~/workspace/{slug}/` | Active |"
    content = mdtables.insert_rows(content, [new_row], header_contains=("Project", "Path"))

    env.agent_map.write_text(content)
    print(f"  Updated agent_map.md with project '{name}'")


def main():
    config_path, argv = parse_config_arg(sys.argv[1:])
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    env = Environment.load(config_path)

    name = argv[0]
    room = None
    source = None

    i = 1
    while i < len(argv):
        if argv[i] == "--room" and i + 1 < len(argv):
            room = argv[i + 1]
            i += 2
        elif argv[i] == "--source" and i + 1 < len(argv):
            source = argv[i + 1]
            i += 2
        else:
            i += 1

    create_workspace(env, name, room=room, source=source)


if __name__ == "__main__":
    main()
