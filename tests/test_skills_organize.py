"""Tests for agent_env/skills_organize.py — room mapping, skill assignment, index generation."""
from __future__ import annotations

from pathlib import Path

import pytest

from agent_env import skills_organize
from agent_env.config import Config, DEFAULTS
from agent_env.environment import Environment

from tests.helpers import make_env, make_config, write_skill, write_skill_block_scalar


class TestGetSkillDescription:
    """get_skill_description extracts one-liner from SKILL.md frontmatter."""

    def test_skill_with_description(self, tmp_path):
        """get_skill_description extracts description from SKILL.md frontmatter."""
        env = make_env(tmp_path)
        write_skill(env, "my-skill", description="Does something useful")
        desc = skills_organize.get_skill_description(env, "my-skill")
        assert desc == "Does something useful"

    def test_skill_without_description(self, tmp_path):
        env = make_env(tmp_path)
        write_skill(env, "bare-skill")
        desc = skills_organize.get_skill_description(env, "bare-skill")
        assert desc == ""

    def test_missing_skill(self, tmp_path):
        env = make_env(tmp_path)
        desc = skills_organize.get_skill_description(env, "nonexistent")
        assert desc == ""

    def test_block_scalar_literal(self, tmp_path):
        """Block scalar with | indicator reads the indented continuation lines."""
        env = make_env(tmp_path)
        write_skill_block_scalar(env, "pipe-skill", indicator="|",
                                 description_lines=["First sentence.", "Second sentence."])
        desc = skills_organize.get_skill_description(env, "pipe-skill")
        assert "First sentence." in desc
        assert "Second sentence." in desc

    def test_block_scalar_folded(self, tmp_path):
        """Block scalar with > indicator also reads continuation lines."""
        env = make_env(tmp_path)
        write_skill_block_scalar(env, "gt-skill", indicator=">",
                                 description_lines=["Folded description line."])
        desc = skills_organize.get_skill_description(env, "gt-skill")
        assert "Folded description line." in desc

    def test_block_scalar_truncated(self, tmp_path):
        """Block scalar descriptions over 100 chars are truncated to 97 + '...'."""
        env = make_env(tmp_path)
        long_line = "x" * 105
        write_skill_block_scalar(env, "long-skill", indicator="|",
                                 description_lines=[long_line])
        desc = skills_organize.get_skill_description(env, "long-skill")
        assert len(desc) <= 100
        assert desc.endswith("...")


class TestGetAllSkillNames:
    """get_all_skill_names discovers skills from the pool."""

    def test_finds_skills(self, tmp_path):
        env = make_env(tmp_path)
        write_skill(env, "skill-a")
        write_skill(env, "skill-b")
        names = skills_organize.get_all_skill_names(env)
        assert "skill-a" in names
        assert "skill-b" in names

    def test_empty_pool(self, tmp_path):
        env = make_env(tmp_path)
        names = skills_organize.get_all_skill_names(env)
        assert isinstance(names, list)

    def test_ignores_files(self, tmp_path):
        env = make_env(tmp_path)
        (env.skills_dir / "not-a-skill.txt").write_text("text")
        names = skills_organize.get_all_skill_names(env)
        assert "not-a-skill.txt" not in names


class TestAssignRooms:
    """assign_rooms builds the skill→room mapping from config."""

    def test_basic_assignment(self):
        config = make_config(
            skills={
                "rooms": {
                    "research": {
                        "description": "Research skills",
                        "skills": ["arxiv", "research-start"],
                    },
                },
                "skill_category_to_room": {},
            }
        )
        mapping = skills_organize.assign_rooms(config)
        assert mapping["arxiv"] == "research"
        assert mapping["research-start"] == "research"

    def test_empty_rooms(self):
        config = Config.defaults()
        mapping = skills_organize.assign_rooms(config)
        assert isinstance(mapping, dict)
        assert len(mapping) == 0


class TestAssignCategorizedSkills:
    """assign_categorized_skills maps category-pool skills to rooms."""

    def test_with_categorized_pool(self, tmp_path):
        env = make_env(tmp_path)
        # Create a categorized pool under skills_dir/<category>/<skill>/
        cat_skill = env.skills_dir / "software-development" / "test-skill"
        cat_skill.mkdir(parents=True, exist_ok=True)
        (cat_skill / "SKILL.md").write_text("---\n---\n\n# test-skill\n")

        from agent_env.environment import Environment
        config = make_config(
            skills={
                "skill_category_to_room": {"software-development": "devops"},
                "rooms": {},
            }
        )
        env2 = Environment(tmp_path, config)
        mapping = skills_organize.assign_categorized_skills(env2)
        assert "test-skill" in mapping
        assert mapping["test-skill"] == "devops"

    def test_uncategorised_uses_default_room(self, tmp_path):
        """Skills with no category mapping fall back to skill_default_room."""
        env = make_env(tmp_path)
        cat_skill = env.skills_dir / "unknown-category" / "mystery-skill"
        cat_skill.mkdir(parents=True, exist_ok=True)
        (cat_skill / "SKILL.md").write_text("---\n---\n\n# mystery-skill\n")

        config = make_config(
            skills={
                "skill_category_to_room": {},
                "rooms": {},
                "default_room": "research",
            }
        )
        env2 = Environment(tmp_path, config)
        mapping = skills_organize.assign_categorized_skills(env2)
        assert mapping.get("mystery-skill") == "research"

    def test_default_room_property(self):
        """Config.skill_default_room defaults to 'devops' and is overridable."""
        default_cfg = make_config()
        assert default_cfg.skill_default_room == "devops"

        custom_cfg = make_config(skills={"default_room": "writing"})
        assert custom_cfg.skill_default_room == "writing"


class TestGenerateRoomIndex:
    """generate_room_index produces a skills_index.md for a room."""

    def test_basic_index(self, tmp_path):
        env = make_env(tmp_path)
        write_skill(env, "my-skill", description="A test skill")
        room_data = {"description": "Test room", "skills": ["my-skill"]}
        content = skills_organize.generate_room_index(
            env, "test_room", room_data, ["my-skill"], {}
        )
        assert "my-skill" in content
        assert "Test room" in content
        assert "A test skill" in content  # description now correctly populated

    def test_skill_without_description(self, tmp_path):
        env = make_env(tmp_path)
        write_skill(env, "bare-skill")
        room_data = {"description": "Room", "skills": ["bare-skill"]}
        content = skills_organize.generate_room_index(
            env, "test_room", room_data, ["bare-skill"], {}
        )
        assert "bare-skill" in content
        assert "see SKILL.md" in content  # fallback description


class TestCheckUnassigned:
    """check_unassigned finds skills not assigned to any room."""

    def test_all_assigned(self, tmp_path):
        env = make_env(tmp_path)
        write_skill(env, "skill-a")
        config = make_config(
            skills={
                "rooms": {
                    "research": {"description": "Research", "skills": ["skill-a"]},
                },
                "skill_category_to_room": {},
            }
        )
        env2 = Environment(tmp_path, config)
        skill_to_room = skills_organize.assign_rooms(env2.config)
        for s, r in skills_organize.assign_categorized_skills(env2).items():
            skill_to_room.setdefault(s, r)
        unassigned = skills_organize.check_unassigned(env2, ["skill-a"], skill_to_room)
        assert len(unassigned) == 0

    def test_unassigned_found(self, tmp_path):
        env = make_env(tmp_path)
        write_skill(env, "orphan-skill")
        unassigned = skills_organize.check_unassigned(
            env, ["orphan-skill"], {}
        )
        assert "orphan-skill" in unassigned