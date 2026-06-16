# Sample Database

> Generic demo database for exploring the data layer.
> Replace this with your own domain-specific database.

## Schema

### Table: `notes`

Stores short notes with a title, body, and tag.

```sql
CREATE TABLE notes (
    id    INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body  TEXT,
    tag   TEXT
);
```

### Table: `metrics`

Stores simple key-value metrics with an optional unit.

```sql
CREATE TABLE metrics (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,
    value REAL,
    unit  TEXT
);
```

## Sample Queries

```bash
# List all notes
sqlite3 data/sample_db/sample.db "SELECT id, title, tag FROM notes;"

# Find notes by tag
sqlite3 data/sample_db/sample.db "SELECT * FROM notes WHERE tag = 'example';"

# Summarize metrics
sqlite3 data/sample_db/sample.db "SELECT name, value, unit FROM metrics ORDER BY name;"
```

## Refresh

This is a demo database with static seed data. In a real setup, add a
`seed.py` script and document how to rebuild from source files.
