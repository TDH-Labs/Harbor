#!/usr/bin/env python3
"""
beacon_sync.py — Discover projects and regenerate all AI beacon files.

Single source of truth: agent_map.md (for room definitions and manual entries).
Discovery: scans the workspace, the root, and project directories for anything new.
Repairs: missing compaction files, stale AGENTS.md, unsynced agent_map entries.

All paths flow through an Environment (built from config); generated beacon text
references the actual resolved root, not a hardcoded home.

Usage:
  python -m agent_env.beacon_sync                  # discover + generate + update agent_map
  python -m agent_env.beacon_sync --sync            # same as above (explicit)
  python -m agent_env.beacon_sync --generate-only   # only generate beacons, no discovery
  python -m agent_env.beacon_sync --config PATH ...  # use a specific config.toml
"""

import os
import sys
from pathlib import Path

from agent_env import mdtables
from agent_env import skill_tracker as _skill_tracker
from agent_env import sync_obsidian_index as _obsidian_index
from agent_env.environment import Environment, parse_config_arg

# Provenance stamp appended to every home-level beacon by this tool.
# Its presence signals that agent-env generated the file; absence means
# another tool (Goose, Hermes, n8n, etc.) has overwritten it since the
# last sync — agent-env check warns when the stamp is missing.
BEACON_STAMP = "<!-- agent-env:sync -->"


def read_file(path):
    if path.exists():
        return path.read_text()
    return ""


def write_beacon(env, path, content, force_write=False):
    """Write a beacon file. Uses symlinks to the home AGENTS.md for project-level
    files unless force_write=True (for home-level beacons which have different
    content)."""
    if force_write:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        print(f"  Wrote {path}")
    else:
        # Project-level AGENTS.md: symlink to the home-level one
        source = env.root / "AGENTS.md"
        if path.is_symlink():
            if os.readlink(str(path)) == str(source):
                return  # Already correct symlink
            path.unlink()
        elif path.exists():
            path.unlink()
        path.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(str(source), str(path))
        print(f"  Symlinked {path} → {source}")


def write_file(path, content):
    """Write a regular file (compaction files, agent_map, etc.)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    print(f"  Wrote {path}")


# ── Discovery ──────────────────────────────────────────────────────────────

def is_project_dir(env, path):
    """Check if a directory looks like a project (has recognizable markers)."""
    if not path.is_dir():
        return False
    name = path.name
    if name.startswith(".") or name in env.config.skip_dirs:
        return False
    # Check for project signatures
    for sig in env.config.project_signatures:
        if (path / sig).exists():
            return True
    return False


def discover_home_projects(env):
    """Scan the root for project directories not yet in workspace."""
    found = []
    for entry in env.root.iterdir():
        if entry.is_dir() and is_project_dir(env, entry):
            found.append(entry)
    return sorted(found, key=lambda p: p.name.lower())


def discover_workspace_projects(env):
    """Scan the workspace for any directories."""
    found = []
    if env.workspace.exists():
        for entry in env.workspace.iterdir():
            if entry.is_dir():
                found.append(entry)
    return sorted(found, key=lambda p: p.name.lower())


def discover_all(env):
    """Combine workspace + home projects, deduplicating."""
    workspace_dirs = discover_workspace_projects(env)
    home_dirs = discover_home_projects(env)

    # Build a map by name for dedup
    workspace_names = {d.name.lower(): d for d in workspace_dirs}
    all_projects = list(workspace_dirs)

    for h in home_dirs:
        if h.name.lower() not in workspace_names:
            all_projects.append(h)

    return all_projects


# ── Agent Map Parsing & Updating ───────────────────────────────────────────

def parse_agent_map(content):
    """Parse agent_map.md into structured sections."""
    sections = {}
    current_section = "preamble"
    sections[current_section] = []

    for line in content.split("\n"):
        if line.startswith("## "):
            current_section = line[3:].strip()
            sections[current_section] = []
        else:
            sections[current_section].append(line)

    return sections


# Table parse/insert is consolidated in mdtables (decision #10). Re-exported here
# so existing call sites (parse_rooms_from_map, parse_projects_from_map) and any
# importers keep working.
parse_table = mdtables.parse_table


# ── Beacon Generation ──────────────────────────────────────────────────────

def parse_rooms_from_map(content):
    """Extract room table from agent_map.md."""
    sections = parse_agent_map(content)
    for section_name, lines in sections.items():
        for line in lines:
            if line.strip().startswith("| Room"):
                return parse_table(lines)
    return []


def parse_projects_from_map(content):
    """Extract project table from agent_map.md."""
    sections = parse_agent_map(content)
    for section_name, lines in sections.items():
        for line in lines:
            if "| Project" in line and "Path" in line:
                return parse_table(lines)
    return []


def extract_path_slug(path_str):
    """Extract a normalized slug from a path like `~/workspace/bookkeeping/` or `~/my-project/`."""
    path_str = path_str.strip().strip("`")
    # Remove ~ and expand
    path_str = path_str.replace("~/", "")
    # Remove trailing slash
    path_str = path_str.rstrip("/")
    # Remove workspace/ prefix if present
    if path_str.startswith("workspace/"):
        path_str = path_str[len("workspace/"):]
    # Return the last component as the slug
    return path_str.split("/")[-1].lower()


def generate_home_agents_md(env, content, rooms, projects):
    """Generate the home AGENTS.md from agent_map.md data."""
    home = env.home_str
    lines = [
        "# AGENTS.md — Machine Orientation for AI Agents",
        "",
        "> **READ THIS FILE FIRST.** It is the entry point to this machine's cognitive architecture.",
        "",
        "## Quick Orientation",
        "",
        "This machine uses a **5-layer structure** for AI agent context:",
        "",
        f"1. **The Map:** `{home}/agent_map.md` — Global routing, room index, project table, security boundaries",
        f"2. **The Rooms:** `{home}/rooms/<domain>/` — Domain-specific rules, skills, and constraints",
        f"3. **The Workspace:** `{home}/workspace/<project>/` — Active project files, compaction artifacts",
        f"4. **The Data Layer:** `{home}/data/` — Structured, queryable data (SQLite + catalog.md)",
        f"5. **The Knowledge Base:** `{home}/Obsidian/` — Conceptual, cross-linked notes ([[wikilinks]])",
        "",
        "## Startup Protocol",
        "",
        "Before doing any work, follow this sequence:",
        "",
        f"1. **Read the Map:** `cat {home}/agent_map.md`",
        "2. **Identify your task's room** from the room index in the map",
        f"3. **Read the room rules:** `cat {home}/rooms/<domain>/room_rules.md`",
        f"4. **If skills are relevant:** `cat {home}/rooms/<domain>/skills_index.md`",
        f"5. **Navigate to the workspace:** `cd {home}/workspace/<project>/`",
        "",
        "## Core Rules",
        "",
        "- **Never work out of `~/Downloads/`** — move files to the appropriate workspace first",
        f"- **Never traverse outside `{home}/`** unless explicitly asked",
        "- **Secrets are in `~/secrets/`** — gitignored, 600 permissions, only read when needed for an API call",
        "- **Large tool outputs (>50 lines):** dump to the project's `scratchpad.md` and read iteratively",
        "- **Compaction workflow:** Research → `research.md` → Synthesize → `plan.md` → Execute from plan only",
        "",
        "## Data Layer (Structured Data)",
        "",
        "Structured data that doesn't fit the file tree lives in `~/data/` as SQLite databases.",
        "Read `~/data/catalog.md` to discover available databases, schema, and query examples.",
        "Each database has a README.md with full documentation.",
        "",
        "```bash",
        "# Discover databases",
        "cat ~/data/catalog.md",
        "# Query a database",
        'sqlite3 ~/data/<domain>/<domain>.db "SELECT * FROM <table> LIMIT 5;"',
        "```",
        "",
        "## Knowledge Base (Obsidian Vault)",
        "",
        "Conceptual knowledge that connects ideas lives in `~/Obsidian/` — deal notes, SOPs, research synthesis.",
        "Use bidirectional `[[links]]` to connect concepts. Templates are in `~/Obsidian/_templates/`.",
        "",
        "```bash",
        "# Discover knowledge domains",
        "ls ~/Obsidian/",
        "# Read a knowledge note",
        "cat '~/Obsidian/<folder>/<note>.md'",
        "```",
        "",
        "## MANDATORY: Skill Loading Before Tasks",
        "",
        "Before starting ANY task, you MUST:",
        "1. **Identify the domain** → which room does this task belong to?",
        "2. **Read the room's skills_index.md** → `cat ~/rooms/<domain>/skills_index.md`",
        "3. **Load ALL relevant skills** → if 2 or 3 skills match your task, load them ALL",
        "4. **Then start work** — never begin a task without checking for applicable skills first",
        "",
        "Multiple skills often apply to a single task — e.g. a reconciliation task might pull in a bookkeeping skill AND a data-cleaning skill AND a spreadsheet-audit skill. Load every relevant skill for the task before starting.",
        "",
        "## Skill Storage",
        "",
        f"Skills live in `{env.config.skills_dir_template.rstrip('/')}/` — the shared pool agents read from. Use progressive disclosure:",
        "- **Map:** This file shows room → skill counts",
        "- **Room:** `~/rooms/<domain>/skills_index.md` has skill names + descriptions",
        f"- **Detail:** `cat {env.config.skills_dir_template.rstrip('/')}/<name>/SKILL.md` — load only what you need",
        "",
        "## Room Index",
        "",
        "| Room | Path | When to Enter |",
        "|------|------|---------------|",
    ]
    for r in rooms:
        name = r.get("Room", "")
        path = r.get("Path", "")
        purpose = r.get("Purpose", "")
        lines.append(f"| {name} | {path} | {purpose} |")

    lines += [
        "",
        "## Project Index",
        "",
        "| Project | Workspace Path | Status |",
        "|---------|---------------|--------|",
    ]
    for p in projects:
        name = p.get("Project", "")
        path = p.get("Path", p.get("Workspace", ""))
        status = p.get("Status", "Active")
        lines.append(f"| {name} | {path} | {status} |")

    lines += [
        "",
        "Each workspace has a `project` symlink pointing to the original codebase location.",
        "",
        "## Security",
        "",
        f"- **Root scope:** `{home}/` — all file operations must resolve within this prefix",
        "- **Secrets vault:** `~/secrets/` — never committed, never read into context unless making a specific API call",
        "- **Blocked paths:** Never write to `/System/`, `/Library/`, other user home dirs",
        "- **Downloads:** Staging only. Move to workspace before processing.",
        "",
        BEACON_STAMP,
    ]
    return "\n".join(lines)


def generate_home_claude_md(env):
    home = env.home_str
    skills = env.config.skills_dir_template.rstrip("/") + "/"
    return f"""# CLAUDE.md — Machine Orientation

> **Read `{home}/agent_map.md` first.** It contains the full routing table, room index, and security boundaries for this machine.

## Quick Start

1. `cat {home}/agent_map.md` — read the map
2. Identify which room your task belongs to
3. `cat {home}/rooms/<domain>/room_rules.md` — read domain rules
4. `cd {home}/workspace/<project>/` — work in the workspace

## Key Conventions

- **Workspace-first:** All active work happens in `~/workspace/<project>/`, not `~/Downloads/` or `~/Desktop/`
- **Compaction workflow:** Research → `research.md` → Plan → `plan.md` → Execute from plan only
- **Large outputs:** Dump to `scratchpad.md`, read iteratively (never flood context)
- **Secrets:** `~/secrets/` only, 600 permissions, never committed
- **Skills:** Read pool is `{skills}` — agents load skills from here. Skills are authored in source dirs and symlinked in (see `config.toml [skill_pool.sources]`).
- **Room rules are mandatory** — each domain has constraints in its `room_rules.md`

## References

- `{home}/AGENTS.md` — Full orientation (cross-tool beacon)
- `{home}/agent_map.md` — Master routing and project table
- `{home}/rooms/*/room_rules.md` — Domain-specific rules
- `{home}/rooms/*/skills_index.md` — Available skills per domain
- `{home}/workspace/MAPPING.md` — Symlink mapping between workspace dirs and originals

{BEACON_STAMP}
"""


def generate_home_cursorrules(env, rooms):
    home = env.home_str
    # Render the room list from the parsed map (decision: no hardcoded rooms).
    # Use the path slug (~/rooms/<domain>/ -> <domain>) so the names match the
    # `<domain>` directories referenced in step 3, not the display-name column.
    room_names = ", ".join(extract_path_slug(r.get("Path", "")) for r in rooms)
    return f"""# Machine Orientation — Read First

Before doing any work on this machine:

1. Read `{home}/agent_map.md` — the master routing table
2. Identify which room your task belongs to ({room_names})
3. Read `{home}/rooms/<domain>/room_rules.md` — domain-specific rules
4. Work in `{home}/workspace/<project>/` — never work from ~/Downloads/ directly

## Key Rules

- All active work goes in `~/workspace/<project>/` with compaction files (research.md, plan.md, scratchpad.md)
- Secrets are quarantined in `~/secrets/` with 600 permissions — only read when making specific API calls
- Never traverse outside `{home}/` unless explicitly asked
- Use `~/workspace/<project>/project/` symlink for codebase access (original locations may have hard-coded paths)
- The room structure under `~/rooms/` contains domain-specific skills and constraints — respect them

See `{home}/AGENTS.md` for full orientation details.

{BEACON_STAMP}
"""


def generate_project_agents_md(env, project_name):
    home = env.home_str
    return f"""# {project_name} — Project AGENTS.md

> This project is part of the machine's 5-layer structure. Read the machine-level orientation first.

## Machine Orientation

1. **Read the Map:** `{home}/agent_map.md`
2. **Read the Room:** `{home}/rooms/<domain>/room_rules.md`
3. **Full beacon:** `{home}/AGENTS.md`

## This Project

- **Workspace:** `~/workspace/{project_name}/`
- **Codebase:** `~/workspace/{project_name}/project/` (symlink to original location)
- **Compaction files:** `research.md`, `plan.md`, `scratchpad.md`

## Compaction Workflow

1. Ingest raw data → `research.md`
2. Synthesize findings → `plan.md` (get user sign-off)
3. Execute from `plan.md` only — clear/ignore `research.md` during execution
"""


# ── Workspace Repair ───────────────────────────────────────────────────────

def ensure_workspace_dir(env, project_dir):
    """Ensure a workspace directory has all required files."""
    name = project_dir.name
    created = []

    # Ensure compaction files exist
    for compaction in ["research.md", "plan.md", "scratchpad.md"]:
        cp = project_dir / compaction
        if not cp.exists():
            write_file(cp, f"# {compaction.replace('.md', '').title()}\n\n# {name}\n\n")
            created.append(cp)

    # Ensure the per-project beacon (config: beacons.project_beacon) is symlinked
    # to the home-level beacon (single source of truth).
    beacon_name = env.config.project_beacon
    write_beacon(env, project_dir / beacon_name, None)
    created.append(project_dir / beacon_name)

    return created


def check_symlink(env, project_dir):
    """Check if a workspace dir has a 'project' symlink pointing somewhere."""
    symlink = project_dir / "project"
    if symlink.is_symlink():
        target = os.readlink(str(symlink))
        resolved = str(Path(str(symlink)).parent / target)
        resolved = resolved.replace(env.home_str, "~")
        return resolved
    elif symlink.is_dir():
        return "directory (not symlink)"
    return None


def discover_project_symlink_target(env, project_dir):
    """If the workspace dir doesn't have a symlink, try to find the original project."""
    # Check common locations
    name = project_dir.name
    # Also check case variations
    for entry in env.root.iterdir():
        if entry.is_dir() and entry.name.lower() == name.lower() and entry != project_dir:
            if is_project_dir(env, entry):
                return f"~/{entry.name}"
    return None


# ── Main Sync Logic ────────────────────────────────────────────────────────

def run_discovery(env):
    """Discover all projects and report what's new or missing."""
    print("beacon_sync: Discovering projects\n")

    content = read_file(env.agent_map)
    if not content:
        print("ERROR: agent_map.md not found or empty.")
        sys.exit(1)

    # Parse current state from agent_map.md
    projects = parse_projects_from_map(content)
    existing_project_slugs = set()
    for p in projects:
        path = p.get("Path", p.get("Workspace", ""))
        slug = path.replace("~/workspace/", "").replace(f"{env.home_str}/workspace/", "").strip("`/ ")
        existing_project_slugs.add(slug.lower())

    # Discover workspace dirs
    workspace_dirs = discover_workspace_projects(env)
    print(f"Workspace directories: {len(workspace_dirs)}")
    for wd in workspace_dirs:
        symlink = check_symlink(env, wd)
        has_agents = (wd / "AGENTS.md").exists()
        status_parts = []
        if not has_agents:
            status_parts.append("MISSING AGENTS.md")
        if symlink:
            status_parts.append(f"→ {symlink}")
        else:
            status_parts.append("(no symlink)")
            # Try to discover the original project
            target = discover_project_symlink_target(env, wd)
            if target:
                status_parts.append(f"(possible original: {target})")
        status = ", ".join(status_parts) if status_parts else "OK"
        new_marker = " [NEW]" if wd.name.lower() not in existing_project_slugs else ""
        print(f"  {wd.name}/{new_marker} ({status})")

    # Discover home-level projects not in workspace or map
    home_dirs = discover_home_projects(env)
    workspace_names = {wd.name.lower() for wd in workspace_dirs}

    # Build complete set of tracked names from map entries
    tracked_names = set(workspace_names)
    for p in projects:
        path = p.get("Path", p.get("Workspace", ""))
        slug = extract_path_slug(path)
        tracked_names.add(slug)
        # Also add the full dir name for non-workspace paths like ~/my-project/
        full_path = path.strip().strip("`").replace("~/", env.home_str + "/")
        dir_name = Path(full_path.rstrip("/")).name.lower()
        tracked_names.add(dir_name)

    untracked = [h for h in home_dirs if h.name.lower() not in tracked_names]
    if untracked:
        print("\nUntracked home projects (not in workspace or map):")
        for h in untracked:
            sigs = [s for s in env.config.project_signatures if (h / s).exists()]
            print(f"  ~/{h.name}/  (signatures: {', '.join(sigs)})")

    # Check for home-level projects that ARE in the map but NOT in workspace
    in_map_not_workspace = []
    for p in projects:
        path = p.get("Path", p.get("Workspace", ""))
        slug = extract_path_slug(path)
        full_path = path.strip().strip("`").replace("~/", env.home_str + "/")
        ws_dir = env.workspace / slug
        # Only flag workspace-path entries that are missing
        if "workspace" in path.lower() and not ws_dir.exists():
            in_map_not_workspace.append((slug, path))

    if in_map_not_workspace:
        print("\nIn agent_map but missing from workspace:")
        for slug, path in in_map_not_workspace:
            print(f"  {slug} → {path}")

    return workspace_dirs, untracked, in_map_not_workspace


def run_update(env, workspace_dirs, untracked, in_map_not_workspace):
    """Update agent_map.md with new discoveries, then regenerate all beacons."""
    print("\nUpdating agent_map.md...")

    content = read_file(env.agent_map)

    # Add workspace dirs that aren't in the map yet
    projects = parse_projects_from_map(content)
    existing_slugs = set()
    for p in projects:
        path = p.get("Path", p.get("Workspace", ""))
        existing_slugs.add(extract_path_slug(path))

    # Also add home-level project names that are already tracked (by directory name)
    for p in projects:
        path = p.get("Path", p.get("Workspace", ""))
        full_path = path.strip().strip("`").replace("~/", env.home_str + "/")
        dir_name = Path(full_path.rstrip("/")).name.lower()
        existing_slugs.add(dir_name)

    new_entries = []
    for wd in workspace_dirs:
        if wd.name.lower() not in existing_slugs:
            display_name = wd.name.replace("-", " ").replace("_", " ").title()
            new_entries.append(f"| {display_name} | `~/workspace/{wd.name}/` | Active |")

    # Also add untracked home projects as map entries (but don't create workspace dirs)
    # These get a direct path instead of ~/workspace/
    for h in untracked:
        display_name = h.name.replace("-", " ").replace("_", " ").title()
        new_entries.append(f"| {display_name} | `~/{h.name}/` | Active |")

    if new_entries:
        for entry in new_entries:
            print(f"  Adding: {entry}")

        # Insert the new rows after the last row of the project table.
        content = mdtables.insert_rows(content, new_entries, header_contains=("Project", "Path"))
        write_file(env.agent_map, content)
    else:
        print("  No new projects to add")

    # For in_map_not_workspace: create the workspace dirs that are referenced but missing
    for slug, path in in_map_not_workspace:
        ws_dir = env.workspace / slug
        ws_dir.mkdir(parents=True, exist_ok=True)
        print(f"  Created missing workspace dir: {ws_dir}")

    return content if new_entries else read_file(env.agent_map)


def run_generate(env, content=None):
    """Regenerate all beacon files from agent_map.md."""
    print("\nGenerating beacon files...")

    if content is None:
        content = read_file(env.agent_map)
    if not content:
        print("ERROR: agent_map.md not found or empty.")
        sys.exit(1)

    rooms = parse_rooms_from_map(content)
    projects = parse_projects_from_map(content)

    # Home-level beacons (force_write=True: each has unique content). Targets
    # come from config (beacons.home_targets); each name maps to its generator.
    print("Home-level beacons:")
    home_beacon_generators = {
        "AGENTS.md": lambda: generate_home_agents_md(env, content, rooms, projects),
        "CLAUDE.md": lambda: generate_home_claude_md(env),
        ".cursorrules": lambda: generate_home_cursorrules(env, rooms),
    }
    for target in env.config.home_beacon_targets:
        generator = home_beacon_generators.get(target)
        if generator is None:
            print(f"  WARNING: no generator for beacon target '{target}', skipping")
            continue
        write_beacon(env, env.root / target, generator(), force_write=True)

    # Workspace-level beacons
    print("Workspace-level beacons:")
    if env.workspace.exists():
        for entry in env.workspace.iterdir():
            if entry.is_dir():
                ensure_workspace_dir(env, entry)

    # Skill pool sync: ensure the shared pool includes all configured source skills
    print("Skill pool sync:")
    sync_skill_pool(env)

    # Record the schema version in the state dir (decision #6).
    write_version_file(env)


def write_version_file(env):
    """Write the schema version stamp to ~/.agent-env/version (idempotent)."""
    vf = env.version_file
    if read_file(vf).strip() != env.config.schema_version:
        vf.parent.mkdir(parents=True, exist_ok=True)
        write_file(vf, env.config.schema_version + "\n")


def stamp_map_version(env):
    """Ensure agent_map.md carries a schema-version comment (idempotent).

    Only ever adds the comment once; later syncs are a no-op, so the watcher
    (which fires on agent_map.md changes) does not loop on the source."""
    content = read_file(env.agent_map)
    if not content or "<!-- agent-env schema:" in content:
        return
    comment = f"<!-- agent-env schema: {env.config.schema_version} -->"
    lines = content.split("\n")
    insert_at = 1 if lines and lines[0].startswith("# ") else 0
    lines.insert(insert_at, comment)
    write_file(env.agent_map, "\n".join(lines))


def _enumerate_skill_dirs(source, mode):
    """Skill directories within a source. mode='rglob' finds every dir holding a
    SKILL.md (categorized/nested pools); mode='flat' takes the top-level entries
    (an already-flat pool like .agents/skills)."""
    if not source.exists():
        return []
    if mode == "flat":
        return list(source.iterdir())
    return [m.parent for m in source.rglob("SKILL.md")]


def sync_skill_pool(env):
    """Symlink each configured source's skills into its target pool (decision #8).

    Sources come from config (skill_pool.sources), empty by default. Each entry:
        { source, into, mode = "rglob"|"flat", link = "absolute"|"relative" }
    Each source entry declares a source pool, a target pool, and a mode.
    Configure sources in config.toml under [skill_pool.sources].
    """
    sources = env.config.skill_pool_sources
    if not sources:
        print("  Skill pool: no sources configured")
        return

    pool_dirs = []
    total_added = 0
    for entry in sources:
        source = env.resolve(entry["source"])
        into = env.resolve(entry.get("into", env.config.skills_dir_template))
        mode = entry.get("mode", "rglob")
        link = entry.get("link", "absolute")

        into.mkdir(parents=True, exist_ok=True)
        if into not in pool_dirs:
            pool_dirs.append(into)

        added = 0
        for skill_dir in _enumerate_skill_dirs(source, mode):
            target = into / skill_dir.name
            if not target.exists() and not target.is_symlink():
                if link == "relative":
                    os.symlink(os.path.relpath(skill_dir, into), str(target))
                else:
                    os.symlink(str(skill_dir), str(target))
                added += 1
        total_added += added
        print(f"  Linked {added} new skills: {source} → {into}")

    if total_added == 0:
        print("  Skill pool already in sync (no new skills found)")

    # Verify: count broken symlinks across every target pool
    broken = 0
    for d in pool_dirs:
        for sub in d.iterdir():
            if sub.is_symlink() and not sub.resolve().exists():
                broken += 1
                print(f"  WARNING: Broken symlink {sub} → {os.readlink(str(sub))}")
    if broken:
        print(f"  WARNING: {broken} broken symlinks found — run with --repair to clean up")


def full_sync(env):
    """Full pass: discover → update → stamp → generate → hygiene."""
    workspace_dirs, untracked, in_map_not_workspace = run_discovery(env)
    content = run_update(env, workspace_dirs, untracked, in_map_not_workspace)
    stamp_map_version(env)
    run_generate(env, content)
    run_hygiene(env)


def main():
    config_path, argv = parse_config_arg(sys.argv[1:])
    env = Environment.load(config_path)

    if "--generate-only" in argv:
        run_generate(env)
        print("\nDone. Beacons regenerated from agent_map.md (no discovery).")
        return

    full_sync(env)

    print("\nDone. All beacons synced with agent_map.md.")
    print("Run 'python -m agent_env.beacon_sync --generate-only' to skip discovery.")


# ── Hygiene Tasks ──────────────────────────────────────────────────────────


def build_data_catalog(env):
    """Scan ~/data/ for SQLite databases and return ``(catalog_markdown, db_count)``.

    Pure builder (no writes) so the catalog can be rendered and asserted in
    tests. Returns ``(None, 0)`` when there is no ~/data/ directory.
    """
    data_dir = env.data_dir
    if not data_dir.exists():
        return None, 0

    db_entries = []
    all_schema = {}  # db_name -> {table -> {column -> type}}

    for db_file in sorted(data_dir.rglob("*.db")):
        domain = db_file.parent.name
        db_name = db_file.stem
        try:
            import sqlite3
            conn = sqlite3.connect(str(db_file))
            tables = [row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()]
            row_counts = {}
            table_schema = {}
            for t in tables:
                try:
                    count = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                    row_counts[t] = count
                except Exception:
                    row_counts[t] = "?"
                # Extract column names and types for cross-domain mapping
                try:
                    cols = conn.execute(f'PRAGMA table_info("{t}")').fetchall()
                    table_schema[t] = {c[1]: c[2] for c in cols}  # {col_name: col_type}
                except Exception:
                    table_schema[t] = {}
            conn.close()
            tables_str = ", ".join(f"{t}({row_counts[t]})" for t in tables)
            db_entries.append({
                "domain": domain,
                "name": db_name,
                "path": f"~/data/{domain}/{db_name}.db",
                "tables": tables_str,
            })
            all_schema[db_name] = table_schema
        except Exception as e:
            print(f"  WARNING: Could not read {db_file}: {e}")

    if not db_entries:
        # No databases yet — write a template catalog with placeholder
        lines = [
            "# Data Catalog — Queryable Databases",
            "",
            "> **Agents: Read this file to discover what structured data is available.**",
            "> Each database has a README.md with schema, query examples, and refresh instructions.",
            "",
            "| Database | Path | Domain | Tables | Description |",
            "|----------|------|--------|--------|-------------|",
            "| Example A | ~/data/example_a/example_a.db | general | (see README) | Placeholder — replace with your own databases |",
            "| Example B | ~/data/example_b/example_b.db | general | (see README) | Placeholder — replace with your own databases |",
            "",
            "## Cross-Domain Queries",
            "",
            "When a question spans two databases, use ATTACH DATABASE to query across them:",
            "",
            "```sql",
            "-- Example: join matching rows across two databases",
            "ATTACH DATABASE '~/data/example_b/example_b.db' AS other;",
            "SELECT a.id, a.name, o.amount",
            "FROM records a",
            "JOIN other.entries o ON a.id = o.record_id;",
            "```",
            "",
            "## How to Query",
            "",
            "```bash",
            "# List all databases",
            "ls ~/data/*/*.db",
            "",
            "# Quick query (example)",
            "sqlite3 ~/data/example_a/example_a.db \"SELECT name FROM sqlite_master WHERE type='table';\"",
            "",
            "# Interactive mode",
            "sqlite3 ~/data/example_a/example_a.db",
            "```",
            "",
            "## Adding a New Database",
            "",
            "1. Create `~/data/<domain>/<domain>.db` with SQLite",
            "2. Write a `README.md` with schema and query examples",
            "3. Add the `seed.py` script if data can be rebuilt from source files",
            "4. Run `python -m agent_env.beacon_sync` to update this catalog",
        ]
    else:
        # Build catalog with real data
        lines = [
            "# Data Catalog — Queryable Databases",
            "",
            "> **Agents: Read this file to discover what structured data is available.**",
            "> Each database has a README.md with schema, query examples, and refresh instructions.",
            "",
            "## Databases",
            "",
            "| Database | Path | Tables (row counts) |",
            "|----------|------|---------------------|",
        ]
        for entry in db_entries:
            lines.append(f"| {entry['name']} | `{entry['path']}` | {entry['tables']} |")

        # Add cross-domain schema map if multiple databases exist
        if len(db_entries) > 1:
            lines += [
                "",
                "## Cross-Domain Schema Map",
                "",
                "> Columns with the same name across databases can be used as join keys.",
                "",
            ]
            # Find columns that appear in multiple databases (potential join keys)
            col_sources = {}  # col_name -> [(db, table)]
            for db_name, tables in all_schema.items():
                for table, cols in tables.items():
                    for col_name in cols:
                        if col_name not in col_sources:
                            col_sources[col_name] = []
                        col_sources[col_name].append((db_name, table))

            cross_domain_cols = {k: v for k, v in col_sources.items()
                                if len(set(db for db, _ in v)) > 1}

            if cross_domain_cols:
                lines += [
                    "| Column | Appears In | Potential Join |",
                    "|--------|-----------|----------------|",
                ]
                for col, sources in sorted(cross_domain_cols.items()):
                    appears = ", ".join(f"{db}.{tbl}" for db, tbl in sources)
                    join_hint = "YES" if len(set(db for db, _ in sources)) > 1 else "same db"
                    lines.append(f"| {col} | {appears} | {join_hint} |")
            else:
                lines += [
                    "*No shared column names found across databases. Use ATTACH DATABASE for explicit cross-db joins.*",
                ]

            lines += [
                "",
                "## Cross-Domain Queries",
                "",
                "Use `ATTACH DATABASE` to join across databases:",
                "",
                "```sql",
                "-- Attach a second database for cross-domain queries",
                "sqlite3 ~/data/example_a/example_a.db",
                "ATTACH DATABASE '~/data/example_b/example_b.db' AS other;",
                "-- Now query across both databases",
                "SELECT * FROM records",
                "JOIN other.entries ON records.id = other.entries.record_id;",
                "```",
                "",
                "### Per-Database Schema",
                "",
            ]
            for db_name, tables in all_schema.items():
                lines.append(f"**{db_name}.db**")
                lines.append("")
                for table, cols in tables.items():
                    col_str = ", ".join(f"{c} ({t})" if t else c for c, t in cols.items())
                    lines.append(f"- `{table}`: {col_str}")
                lines.append("")

        lines += [
            "## How to Query",
            "",
            "```bash",
            "# List all databases",
            "ls ~/data/*/*.db",
            "",
            "# Quick query (example)",
            'sqlite3 ~/data/example_a/example_a.db "SELECT name FROM sqlite_master WHERE type=\'table\';"',
            "",
            "# Interactive mode",
            "sqlite3 ~/data/example_a/example_a.db",
            "```",
            "",
            "## Adding a New Database",
            "",
            "1. Create `~/data/<domain>/<domain>.db` with SQLite",
            "2. Write a `README.md` with schema and query examples",
            "3. Add the `seed.py` script if data can be rebuilt from source files",
            "4. Run `python -m agent_env.beacon_sync` to update this catalog",
        ]

    return "\n".join(lines), len(db_entries)


def sync_data_catalog(env):
    """Rebuild ~/data/catalog.md from the live databases. Returns change count."""
    content, db_count = build_data_catalog(env)
    if content is None:
        return 0
    catalog_path = env.data_dir / "catalog.md"
    if content.strip() != read_file(catalog_path).strip():
        write_file(catalog_path, content)
        print(f"  Updated data catalog: {db_count} databases")
        return 1
    return 0


def run_hygiene(env):
    """Run non-destructive maintenance: report broken symlinks, sync the data
    catalog, and rebuild the Obsidian and skill indexes. Destructive cleanup
    lives in tidy.py and only runs when config enables it (decision #7)."""
    print("\nRunning hygiene tasks...")

    changes = 0

    changes += report_broken_symlinks(env)
    changes += sync_data_catalog(env)
    changes += sync_obsidian_index(env)
    changes += rebuild_skill_indexes(env)

    # Destructive cleanup is opt-in (decision #7).
    if env.config.tidy_enabled:
        from agent_env import tidy
        changes += tidy.run_tidy(env)

    if changes == 0:
        print("  Hygiene: all clean, no changes needed.")
    else:
        print(f"  Hygiene: {changes} changes made.")


def report_broken_symlinks(env):
    """Report broken symlinks in workspace, skills, and goose skills."""
    broken = 0
    scan_dirs = [
        env.workspace,
        env.skills_dir,
        env.root / ".config" / "goose" / "skills",
    ]
    for scan_dir in scan_dirs:
        if not scan_dir.exists():
            continue
        for entry in scan_dir.rglob("*"):
            if entry.is_symlink() and not entry.resolve().exists():
                print(f"  BROKEN SYMLINK: {entry} → {os.readlink(str(entry))}")
                broken += 1
    return broken


def rebuild_skill_indexes(env):
    """Rebuild room skill indexes with usage data (skill_tracker, imported)."""
    try:
        return _skill_tracker.rebuild_room_indexes(env) or 0
    except Exception as e:
        print(f"  WARNING: Skill index rebuild error: {e}")
        return 0


def sync_obsidian_index(env):
    """Build ~/Obsidian/_index.md from vault frontmatter and headings (imported)."""
    try:
        return _obsidian_index.sync(env)
    except Exception as e:
        print(f"  WARNING: Obsidian index sync error: {e}")
        return 0


if __name__ == "__main__":
    main()
