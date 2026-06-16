#!/usr/bin/env python3
"""
skills_organize.py — Assign every skill to a room and generate room-based skills indexes.

Applies progressive disclosure to skills:
  Layer 1 (Map): agent_map.md lists room names + skill counts
  Layer 2 (Room): rooms/<domain>/skills_index.md lists skill names + one-liners
  Layer 3 (Detail): ~/.agents/skills/<name>/SKILL.md full content (loaded JIT)

The room -> skill mapping and category mapping live in config
(skills.rooms / skills.skill_category_to_room); paths come from the Environment.

Usage:
  python -m agent_env.skills_organize                 # organize + generate indexes
  python -m agent_env.skills_organize --check          # verify all skills are assigned
  python -m agent_env.skills_organize --config PATH     # use a specific config.toml
"""

import os
import sys

from agent_env.environment import Environment, parse_config_arg


def get_skill_description(env, skill_name):
    """Extract one-line description from SKILL.md frontmatter."""
    agents_skills = env.skills_dir

    skill_dir = None
    candidate = agents_skills / skill_name
    if candidate.exists():
        skill_dir = candidate

    if skill_dir is None and agents_skills.exists():
        for cat_dir in agents_skills.iterdir():
            if not cat_dir.is_dir():
                continue
            nested = cat_dir / skill_name
            if nested.exists():
                skill_dir = nested
                break

    if skill_dir is None:
        return ""

    md_path = skill_dir / "SKILL.md"
    if not md_path.exists():
        return ""

    try:
        with open(md_path) as f:
            in_fm = False
            for line in f:
                stripped = line.strip()
                if stripped == "---":
                    if in_fm:
                        break
                    in_fm = True
                    continue
                if in_fm and stripped.startswith("description:"):
                    val = stripped.split(":", 1)[1].strip().strip('"').strip("'")
                    if val.startswith("|") or val.startswith(">"):
                        # YAML block scalar: collect subsequent indented lines
                        parts = []
                        for next_line in f:
                            if next_line and not next_line[0].isspace():
                                break
                            content = next_line.strip()
                            if content:
                                parts.append(content)
                        desc = " ".join(parts)
                    else:
                        desc = val
                    if len(desc) > 100:
                        desc = desc[:97] + "..."
                    return desc
    except Exception:
        pass
    return ""


def get_all_skill_names(env):
    """Get all skill slugs from the agents pool (flat and categorized)."""
    agents_skills = env.skills_dir
    names = set()
    if agents_skills.exists():
        for d in agents_skills.iterdir():
            if d.is_dir() or d.is_symlink():
                names.add(d.name)
                # Also pick up skills nested one level down (categorized pool)
                if d.is_dir():
                    for nested in d.iterdir():
                        if nested.is_dir() and (nested / "SKILL.md").exists():
                            names.add(nested.name)
    return sorted(names)


def assign_rooms(config):
    """Build reverse mapping: skill_name → room_name (from config.skills.rooms)."""
    skill_to_room = {}
    for room, data in config.room_skills.items():
        for skill in data["skills"]:
            skill_to_room[skill] = room
    return skill_to_room


def assign_categorized_skills(env):
    """Map categorized pool skills to rooms via config.skill_category_to_room.

    Walks the flat agents pool looking for directories that contain subdirectories
    with SKILL.md files (categorized layout). Each category directory name is
    looked up in ``config.skill_category_to_room``; unrecognised categories
    default to "devops".
    """
    skill_to_room = {}
    agents_skills = env.skills_dir
    category_to_room = env.config.skill_category_to_room
    if agents_skills.exists():
        for cat_dir in agents_skills.iterdir():
            if not cat_dir.is_dir():
                continue
            # A category dir contains skill subdirs with SKILL.md
            has_skills = any(
                d.is_dir() and (d / "SKILL.md").exists()
                for d in cat_dir.iterdir()
            )
            if not has_skills:
                continue
            room = category_to_room.get(cat_dir.name, env.config.skill_default_room)
            for skill_dir in cat_dir.iterdir():
                if skill_dir.is_dir() and (skill_dir / "SKILL.md").exists():
                    skill_to_room[skill_dir.name] = room
    return skill_to_room


def generate_room_index(env, room_name, room_data, skills_in_room, skill_to_source):
    """Generate a skills_index.md for a room using progressive disclosure."""
    lines = [
        f"# {room_name.replace('_', ' ').title()} Skills Index",
        "",
        f"> {room_data['description']}",
        f"> Skills in this room: {len(skills_in_room)}",
        f"> Storage: `{env.config.skills_dir_template.rstrip('/')}/<name>/SKILL.md` (shared pool)",
        "> Load only the skill you need — do NOT load all skills at once.",
        "",
        "## How to Use Skills in This Room",
        "",
        "1. **Scan** the table below for a skill that matches your task",
        f"2. **Read** only that skill's SKILL.md: `cat {env.config.skills_dir_template.rstrip('/')}/<name>/SKILL.md`",
        "3. **Follow** the skill's instructions — it will tell you exactly what to do",
        "",
        "| Skill | Description |",
        "|-------|-------------|",
    ]

    for skill_name in sorted(skills_in_room):
        desc = get_skill_description(env, skill_name)
        if not desc:
            desc = "(see SKILL.md for details)"
        lines.append(f"| {skill_name} | {desc} |")

    lines.append("")
    lines.append("## Adding Skills to This Room")
    lines.append("")
    lines.append("Add the skill slug to this room's `skills` list in your agent-env")
    lines.append("config (`[skills.rooms.<room>]`), then run `python -m agent_env.skills_organize`.")
    lines.append("")

    return "\n".join(lines)


def generate_master_index(all_skills, skill_to_room, room_data):
    """Generate the master skills map that goes in agent_map.md."""
    lines = [
        "## Skills — Progressive Disclosure",
        "",
        "Do NOT scan all skills. Navigate: Map → Room → Detail.",
        "",
        "| Room | Focus | Skills |",
        "|------|-------|--------|",
    ]
    for room_name in sorted(room_data.keys()):
        room_desc = room_data[room_name]["description"].split(",")[0]
        count = sum(1 for s, r in skill_to_room.items() if r == room_name)
        lines.append(f"| {room_name} | {room_desc} | {count} |")
    lines.append("")
    lines.append(f"Total: {len(all_skills)} skills across {len(room_data)} rooms.")
    lines.append("Room indexes: `~/rooms/<room>/skills_index.md`")
    lines.append("Skill storage: `~/.agents/skills/<name>/SKILL.md`")
    lines.append("")
    return "\n".join(lines)


def check_unassigned(env, all_skills, skill_to_room):
    """Find skills not assigned to any room."""
    unassigned = [s for s in all_skills if s not in skill_to_room]
    if unassigned:
        print(f"\n⚠️  Unassigned skills ({len(unassigned)}):")
        for s in unassigned:
            desc = get_skill_description(env, s)
            print(f"  {s}: {desc[:60]}")
    else:
        print("✅ All skills assigned to rooms.")
    return unassigned


def main():
    config_path, argv = parse_config_arg(sys.argv[1:])
    env = Environment.load(config_path)
    check_mode = "--check" in argv

    room_skills = env.config.room_skills

    # Get all skills
    all_skills = get_all_skill_names(env)
    print(f"Found {len(all_skills)} skills total")

    # Build room assignments
    skill_to_room = assign_rooms(env.config)

    # Add categorized-pool assignments (pools with category subdirs)
    categorized_assignments = assign_categorized_skills(env)
    for skill, room in categorized_assignments.items():
        if skill not in skill_to_room:
            skill_to_room[skill] = room

    # Check for unassigned
    unassigned = check_unassigned(env, all_skills, skill_to_room)

    if check_mode:
        sys.exit(0 if not unassigned else 1)

    # Assign unassigned to the configured default room
    default_room = env.config.skill_default_room
    for skill in unassigned:
        skill_to_room[skill] = default_room
    if unassigned:
        print(f"Assigned {len(unassigned)} unassigned skills to {default_room} (default room)")

    # Build room → skills mapping
    room_to_skills = {}
    for skill, room in skill_to_room.items():
        room_to_skills.setdefault(room, []).append(skill)

    # Determine source for each skill (flat or categorized within agents pool)
    agents_skills = env.skills_dir
    skill_to_source = {}
    if agents_skills.exists():
        for d in agents_skills.iterdir():
            if d.is_dir() or d.is_symlink():
                if (d / "SKILL.md").exists() or os.path.islink(str(d)):
                    skill_to_source[d.name] = "agents"
                elif d.is_dir():
                    # Categorized: nested skill dirs
                    for nested in d.iterdir():
                        if nested.is_dir() and (nested / "SKILL.md").exists():
                            skill_to_source[nested.name] = "agents"

    # Generate room indexes
    for room_name, room_data in room_skills.items():
        skills_in_room = room_to_skills.get(room_name, [])
        if not skills_in_room:
            print(f"  Room {room_name}: no skills assigned, skipping")
            continue

        index_content = generate_room_index(env, room_name, room_data, skills_in_room, skill_to_source)
        room_dir = env.rooms / room_name
        room_dir.mkdir(parents=True, exist_ok=True)
        index_path = room_dir / "skills_index.md"
        index_path.write_text(index_content)
        print(f"  Room {room_name}: {len(skills_in_room)} skills → {index_path}")

    # Generate devops index (catches unassigned + categorized devops skills)
    devops_skills = room_to_skills.get("devops", [])
    if devops_skills:
        devops_data = {
            "description": "Development tools, CI/CD, infrastructure, containers, webhooks, agent orchestration",
            "skills": sorted(devops_skills),  # override with actual assigned skills
        }
        index_content = generate_room_index(env, "devops", devops_data, devops_skills, skill_to_source)
        room_dir = env.rooms / "devops"
        room_dir.mkdir(parents=True, exist_ok=True)
        (room_dir / "skills_index.md").write_text(index_content)
        print(f"  Room devops: {len(devops_skills)} skills → {room_dir / 'skills_index.md'}")

    # Generate research room
    research_skills = room_to_skills.get("research", [])
    if research_skills:
        research_data = {
            "description": "Research, data analysis, papers, market intelligence, creative tools",
            "skills": sorted(research_skills),
        }
        index_content = generate_room_index(env, "research", research_data, research_skills, skill_to_source)
        room_dir = env.rooms / "research"
        room_dir.mkdir(parents=True, exist_ok=True)
        (room_dir / "skills_index.md").write_text(index_content)
        print(f"  Room research: {len(research_skills)} skills → {room_dir / 'skills_index.md'}")

    # Print summary
    print(f"\nTotal skills assigned: {len(skill_to_room)}")
    for room in sorted(room_to_skills.keys()):
        print(f"  {room}: {len(room_to_skills[room])} skills")
    print("\nRoom indexes written to ~/rooms/*/skills_index.md")
    print("Run 'python -m agent_env.beacon_sync' to update agent_map.md with skills overview.")


if __name__ == "__main__":
    main()
