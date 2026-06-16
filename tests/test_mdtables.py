"""Tests for agent_env/mdtables.py — Markdown table parsing and row insertion."""
from __future__ import annotations

import pytest

from agent_env.mdtables import parse_table, is_header_row, find_table_bounds, insert_rows


class TestParseTable:
    """parse_table extracts rows from markdown table lines."""

    def test_simple_table(self):
        lines = [
            "| Name | Age | City |",
            "|------|-----|------|",
            "| Alice | 30 | NYC |",
            "| Bob | 25 | LA |",
        ]
        rows = parse_table(lines)
        assert len(rows) == 2
        assert rows[0] == {"Name": "Alice", "Age": "30", "City": "NYC"}
        assert rows[1] == {"Name": "Bob", "Age": "25", "City": "LA"}

    def test_table_with_leading_trailing_pipe(self):
        lines = [
            "| Name | Age |",
            "|------|-----|",
            "| Alice | 30 |",
        ]
        rows = parse_table(lines)
        assert len(rows) == 1
        assert rows[0]["Name"] == "Alice"

    def test_skips_separator_row(self):
        lines = [
            "| Project | Path | Status |",
            "|---------|------|--------|",
            "| TestProject | ~/workspace/test/ | Active |",
        ]
        rows = parse_table(lines)
        assert len(rows) == 1
        assert rows[0]["Project"] == "TestProject"

    def test_skips_non_table_lines(self):
        lines = [
            "Some intro text",
            "| Name | Age |",
            "|------|-----|",
            "| Alice | 30 |",
            "Some trailing text",
        ]
        rows = parse_table(lines)
        assert len(rows) == 1

    def test_ragged_row_skipped(self):
        """A data row with wrong column count is silently skipped."""
        lines = [
            "| Name | Age | City |",
            "|------|-----|------|",
            "| Alice | 30 | NYC |",
            "| Bob | 25 |",  # missing City
        ]
        rows = parse_table(lines)
        assert len(rows) == 1
        assert rows[0]["Name"] == "Alice"

    def test_empty_input(self):
        assert parse_table([]) == []

    def test_no_table_found(self):
        lines = ["Just some text", "No table here"]
        assert parse_table(lines) == []

    def test_multiple_separators(self):
        """Only one separator row is skipped."""
        lines = [
            "| A | B |",
            "|---|---|",
            "| 1 | 2 |",
        ]
        rows = parse_table(lines)
        assert len(rows) == 1


class TestIsHeaderRow:
    """is_header_row checks if a line is a table header containing required labels."""

    def test_matching_header(self):
        assert is_header_row("| Project | Path | Status |", "Project", "Path")

    def test_non_matching_header(self):
        assert not is_header_row("| Name | Age |", "Project", "Path")

    def test_non_table_line(self):
        assert not is_header_row("Some text", "Project")

    def test_partial_match(self):
        assert not is_header_row("| Project | Age |", "Project", "Path")


class TestFindTableBounds:
    """find_table_bounds locates a table by header labels."""

    def test_finds_table(self):
        content = "Intro\n| Project | Path | Status |\n|---------|------|--------|\n| Alpha | ~/a/ | Active |\n"
        lines = content.split("\n")
        header_idx, last_idx = find_table_bounds(lines, "Project", "Path")
        assert header_idx == 1
        assert last_idx == 3

    def test_table_not_found(self):
        content = "No table here\n"
        lines = content.split("\n")
        header_idx, last_idx = find_table_bounds(lines, "Project")
        assert header_idx is None
        assert last_idx is None

    def test_table_with_trailing_lines(self):
        content = "| Project | Path |\n|---------|------|\n| Alpha | ~/a/ |\n\nMore text\n"
        lines = content.split("\n")
        header_idx, last_idx = find_table_bounds(lines, "Project")
        assert header_idx == 0
        assert last_idx == 2


class TestInsertRows:
    """insert_rows adds rows after a table's last row."""

    def test_insert_into_project_table(self):
        content = """# Map

| Project | Path | Status |
|---------|------|--------|
| Alpha | ~/a/ | Active |

## Security

- Root scope
"""
        new_rows = ["| Beta | ~/b/ | Active |"]
        result = insert_rows(content, new_rows, header_contains=("Project", "Path"))
        assert "| Beta | ~/b/ |" in result
        # New row should be before Security section
        sec_idx = result.index("## Security")
        beta_idx = result.index("| Beta")
        assert beta_idx < sec_idx

    def test_insert_multiple_rows(self):
        content = """| Project | Path | Status |
|---------|------|--------|
| Alpha | ~/a/ | Active |"""
        new_rows = ["| Beta | ~/b/ | Active |", "| Gamma | ~/c/ | Active |"]
        result = insert_rows(content, new_rows, header_contains=("Project",))
        assert "| Beta |" in result
        assert "| Gamma |" in result

    def test_insert_with_fallback(self):
        """When the target table is not found, fall back to heading match."""
        content = """# Map

Some text.

## Security

- Rule 1
"""
        new_rows = ["| Beta | ~/b/ | Active |"]
        result = insert_rows(content, new_rows, header_contains=("Project", "Path"),
                            fallback_headings=("## Security",))
        assert "## Security" in result
        beta_idx = result.index("| Beta")
        sec_idx = result.index("## Security")
        assert beta_idx < sec_idx

    def test_insert_empty_rows_no_change(self):
        content = "| Project | Path |\n|---------|------|\n| A | ~/a |"
        result = insert_rows(content, [], header_contains=("Project",))
        assert result == content

    def test_insert_no_table_no_heading_appends(self):
        """When table and fallback heading both missing, appends."""
        content = "Just text here\n"
        new_rows = ["| Beta | ~/b/ | Active |"]
        result = insert_rows(content, new_rows, header_contains=("Project",),
                            fallback_headings=("## Nonexistent",))
        assert "| Beta |" in result

    def test_insert_preserves_other_sections(self):
        content = """# Map

## Available Rooms

| Room | Path | Purpose |
|------|------|---------|
| DevOps | ~/rooms/devops/ | CI/CD |

## Active Projects

| Project | Path | Status |
|---------|------|--------|
| Alpha | ~/a/ | Active |

## Security

- Root scope
"""
        new_rows = ["| Beta | ~/b/ | Active |"]
        result = insert_rows(content, new_rows, header_contains=("Project", "Path"))
        assert "| Beta |" in result
        # Rooms table should be unchanged
        assert "| DevOps |" in result

    def test_insert_into_table_with_paths_containing_spaces(self):
        """Project paths with spaces should survive insertion."""
        content = """| Project | Path | Status |
|---------|------|--------|
| Alpha | ~/workspace/Alpha Project/ | Active |"""
        new_rows = ["| Beta Project | ~/workspace/Beta Project/ | Active |"]
        result = insert_rows(content, new_rows, header_contains=("Project",))
        assert "Beta Project" in result