# Data Catalog — Queryable Databases

> **Agents: Read this file to discover what structured data is available.**
> Each database has a README.md with schema, query examples, and refresh instructions.

## Databases

| Database | Path | Tables (row counts) |
|----------|------|---------------------|
| sample | `~/data/sample_db/sample.db` | notes(3), metrics(2) |
## How to Query

```bash
# List all databases
ls ~/data/*/*.db

# Quick query (example)
sqlite3 ~/data/example_a/example_a.db "SELECT name FROM sqlite_master WHERE type='table';"

# Interactive mode
sqlite3 ~/data/example_a/example_a.db
```

## Adding a New Database

1. Create `~/data/<domain>/<domain>.db` with SQLite
2. Write a `README.md` with schema and query examples
3. Add the `seed.py` script if data can be rebuilt from source files
4. Run `python -m agent_env.beacon_sync` to update this catalog