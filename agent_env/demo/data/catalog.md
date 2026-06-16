# Data Catalog — Queryable Databases

> **Agents: Read this file to discover what structured data is available.**
> Each database has a README.md with schema, query examples, and refresh instructions.

| Database | Path | Domain | Tables | Description |
|----------|------|--------|--------|-------------|
| sample_db | <root>/data/sample_db/sample.db | general | notes, metrics | Demo database with generic sample data |

## Cross-Domain Queries

When a question spans two databases, use ATTACH DATABASE to query across them:

```sql
-- Example: join matching rows across two databases
ATTACH DATABASE '<root>/data/other/other.db' AS other;
SELECT a.id, a.title, o.value
FROM notes a
JOIN other.metrics o ON a.id = o.note_id;
```

## How to Query

```bash
# List all databases
ls <root>/data/*/*.db

# Quick query
sqlite3 <root>/data/sample_db/sample.db "SELECT name FROM sqlite_master WHERE type='table';"

# Interactive mode
sqlite3 <root>/data/sample_db/sample.db
```

## Adding a New Database

1. Create `<root>/data/<domain>/<domain>.db` with SQLite
2. Write a `README.md` with schema and query examples
3. Add the `seed.py` script if data can be rebuilt from source files
4. Run `agent-env sync` to update this catalog
