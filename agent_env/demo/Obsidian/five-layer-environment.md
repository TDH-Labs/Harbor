---
title: Five-Layer Agent Environment
type: concept
domain: architecture
created: 2024-01-01
tags: [architecture, environment, layers]
---

# Five-Layer Agent Environment

The five-layer architecture organizes agent context into a clear hierarchy,
from persistent knowledge at the base to generated beacons at the surface.

## Layers (bottom to top)

1. **Knowledge** (`Obsidian/`) — cross-linked notes, concepts, domain knowledge
2. **Data** (`data/`) — structured, queryable data (SQLite + catalog.md)
3. **Workspace** (`workspace/<project>/`) — active project files, compaction artifacts
4. **Rooms** (`rooms/<domain>/`) — domain rules, constraints, skill indexes
5. **Beacons** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) — agent entry points

## Key Numbers

- 5 layers total, each with a distinct access pattern
- 1 source of truth: `agent_map.md` drives all beacon generation
- 6h cron cycle for background sync on a typical setup

## How Agents Navigate

An agent reading `AGENTS.md` (layer 5) is directed to `agent_map.md`, which
routes it to the correct room. The room's `room_rules.md` constrains what the
agent may do. Data lives in layer 2 (never in context). Notes in layer 1 are
consulted via `[[wikilinks]]`, not bulk-loaded.

## Related Concepts

See [[compaction-workflow]] for how agents traverse layers efficiently.
See [[knowledge-base-protocol]] for how the knowledge layer is maintained.

## Sources

- agent-environment architecture brief (plan.md, ARCHITECT_BRIEF.md)
- Informed by hierarchical context management in large language model deployments
