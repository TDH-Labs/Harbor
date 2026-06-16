---
title: Data Layer Patterns
type: concept
domain: data-architecture
created: 2024-01-01
tags: [data, sqlite, catalog]
---

# Data Layer Patterns

The data layer holds structured, queryable data in SQLite databases. Each
database is paired with a `README.md` and registered in `catalog.md`. Agents
discover and query data without loading raw files into context.

## Core Pattern: Catalog-First Access

1. Read `data/catalog.md` to discover what databases exist
2. Read the database's `README.md` for schema and query examples
3. Use `sqlite3` or ATTACH DATABASE for cross-database queries
4. Never copy raw rows into the primary context window

## Key Numbers

- Preferred database size: under 100 MB for inline queries
- Cross-database joins: use ATTACH DATABASE, not application-side joins
- Catalog refresh: automatic on every `agent-env sync`

## Example: Querying a Sample Database

```bash
# Discover available tables
sqlite3 data/sample_db/sample.db ".tables"

# Query with a limit to avoid flooding context
sqlite3 data/sample_db/sample.db "SELECT * FROM notes LIMIT 10;"

# Cross-database join
sqlite3 data/sample_db/sample.db "
  ATTACH DATABASE 'data/other/other.db' AS other;
  SELECT s.id, s.title, o.value FROM notes s JOIN other.metrics o ON s.id = o.note_id;
"
```

## When to Use SQLite vs. Files

- **SQLite**: repeated queries, structured/tabular data, joins, aggregates
- **Files**: documents, binary assets, logs that are always consumed whole

## Related Concepts

See [[five-layer-environment]] for how the data layer relates to the other layers.
See [[knowledge-base-protocol]] for how notes and data complement each other.

## Sources

- SQLite documentation: sqlite.org
- agent-environment architecture brief (plan.md §Decision 6)
