#!/usr/bin/env python3
"""
mdtables.py — Shared markdown-table parsing and row insertion.

`agent_map.md` is the single source of truth and is hand-edited, so its tables
must be parsed and modified by code that tolerates the quirks of a real,
human-maintained file: separator rows, ragged/short rows, leading and trailing
pipes, project paths containing spaces, and prose between a table and the next
heading.

This is the one place that logic lives. Before consolidation there were three
divergent copies (two in beacon_sync.py, one in new_project.py); they now all
call through here (decision #10).
"""


def parse_table(lines):
    """Parse the first markdown table found in ``lines`` into a list of dicts
    keyed by the header cells.

    ``lines`` is an iterable of strings (a section of a document). Separator
    rows (``|---|---|``) are skipped, and any data row whose column count does
    not match the header is ignored rather than raising — a bad hand edit
    degrades to a dropped row, not a crash.
    """
    rows = []
    header = None
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        parts = [p.strip() for p in stripped.split("|")]
        parts = [p for p in parts if p]  # remove empties from leading/trailing |
        if not parts:
            continue
        if all(set(p) <= {"-", ":"} for p in parts):
            continue  # separator row
        if header is None:
            header = parts
            continue
        if header and len(parts) == len(header):
            rows.append(dict(zip(header, parts)))
    return rows


def is_header_row(line, *required):
    """True if ``line`` is a table row (starts with ``|``) containing every
    label in ``required``. e.g. ``is_header_row(line, "Project", "Path")``."""
    stripped = line.strip()
    if not stripped.startswith("|"):
        return False
    return all(col in stripped for col in required)


def find_table_bounds(lines, *header_contains):
    """Locate the first table whose header row contains all ``header_contains``
    labels.

    Returns ``(header_idx, last_row_idx)`` — the index of the header row and the
    index of the last contiguous row that starts with ``|`` (separator and data
    rows). Returns ``(None, None)`` if no matching header is found.
    """
    for i, line in enumerate(lines):
        if is_header_row(line, *header_contains):
            last_row_idx = i
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith("|"):
                last_row_idx = j
                j += 1
            return i, last_row_idx
    return None, None


def insert_rows(content, new_rows, *, header_contains, fallback_headings=("## Security", "## Remaining")):
    """Return ``content`` with ``new_rows`` inserted after the last row of the
    first table whose header contains all ``header_contains`` labels.

    Mirrors the long-standing beacon_sync / new_project behavior: append after
    the table's final contiguous ``|`` row. If the table can't be located, fall
    back to inserting before the first heading in ``fallback_headings``; if that
    also fails, append at the end of the document.

    ``new_rows`` is a list of complete row strings (e.g.
    ``"| Name | `~/workspace/x/` | Active |"``). Returns ``content`` unchanged
    when ``new_rows`` is empty.
    """
    if not new_rows:
        return content

    lines = content.split("\n")
    _, last_row_idx = find_table_bounds(lines, *header_contains)
    if last_row_idx is not None:
        for k, row in enumerate(new_rows):
            lines.insert(last_row_idx + 1 + k, row)
        return "\n".join(lines)

    for i, line in enumerate(lines):
        if any(line.startswith(h) for h in fallback_headings):
            for k, row in enumerate(new_rows):
                lines.insert(i + k, row)
            return "\n".join(lines)

    return content + "\n" + "\n".join(new_rows) + "\n"
