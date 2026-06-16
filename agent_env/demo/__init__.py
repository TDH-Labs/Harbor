"""agent_env.demo — Demo content assets and materializer.

Materializes the demo environment under a caller-supplied target root
(typically a tmp directory in tests, or ~/agent-env-demo/ for real runs).
Never writes to any real home path — all paths are derived from root.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

# The directory containing the committed demo asset files.
ASSETS = Path(__file__).parent


def _seed_sqlite(db_path: Path) -> None:
    """Seed the sample SQLite database with a few generic rows."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS notes (
            id    INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            body  TEXT,
            tag   TEXT
        );
        CREATE TABLE IF NOT EXISTS metrics (
            id    INTEGER PRIMARY KEY,
            name  TEXT NOT NULL,
            value REAL,
            unit  TEXT
        );
    """)
    cur.executemany(
        "INSERT OR IGNORE INTO notes (id, title, body, tag) VALUES (?,?,?,?)",
        [
            (1, "Getting Started", "Replace this with your own notes.", "example"),
            (2, "Data Layer Intro", "See data-layer-patterns.md in the vault.", "example"),
            (3, "Compaction Workflow", "Research → plan → execute.", "methodology"),
        ],
    )
    cur.executemany(
        "INSERT OR IGNORE INTO metrics (id, name, value, unit) VALUES (?,?,?,?)",
        [
            (1, "notes_count", 3, "count"),
            (2, "avg_title_len", 18.0, "chars"),
        ],
    )
    con.commit()
    con.close()


def _copy_text(src: Path, dst: Path, substitutions: dict[str, str]) -> None:
    """Copy a text file with placeholder substitution."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    text = src.read_text()
    for placeholder, value in substitutions.items():
        text = text.replace(placeholder, value)
    dst.write_text(text)


def materialize(root: Path) -> list[Path]:
    """Materialize demo content under *root*, returning the list of created paths.

    The caller is responsible for choosing *root*. Tests pass a tmp_path;
    real user runs pass ~/agent-env-demo/. This function never touches the
    real home directory.
    """
    root = Path(root)
    root_str = str(root)
    subs = {"<root>": root_str}

    created: list[Path] = []

    def _track(p: Path) -> Path:
        created.append(p)
        return p

    # agent_map.md
    _copy_text(ASSETS / "demo_agent_map.md", _track(root / "agent_map.md"), subs)

    # rooms
    for room in ("research", "writing"):
        _copy_text(
            ASSETS / "rooms" / room / "room_rules.md",
            _track(root / "rooms" / room / "room_rules.md"),
            subs,
        )

    # Obsidian vault notes
    for note in ASSETS.glob("Obsidian/*.md"):
        _copy_text(note, _track(root / "Obsidian" / note.name), subs)

    # Data layer
    _copy_text(ASSETS / "data" / "catalog.md",
               _track(root / "data" / "catalog.md"), subs)
    _copy_text(
        ASSETS / "data" / "sample_db" / "README.md",
        _track(root / "data" / "sample_db" / "README.md"),
        subs,
    )
    db_path = root / "data" / "sample_db" / "sample.db"
    _seed_sqlite(db_path)
    created.append(db_path)

    # Workspace compaction files
    ws = root / "workspace" / "example-project"
    for fname in ("research.md", "plan.md", "scratchpad.md"):
        _copy_text(ASSETS / "workspace" / "example-project" / fname,
                   _track(ws / fname), subs)

    return created
