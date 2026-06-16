<!-- agent-env schema: 1.0 -->
# Agent Core Map & Routing Protocol

> The single source of truth for this generic fixture environment.
> Edit this file; run `agent-env sync` to regenerate all beacons.

## Host Profile

- Machine: fixture-host
- Industry: General (fixture)
- Organization mode: both

## Architectural Overview

This environment uses a 5-layer structure for agent context:
knowledge → data → workspace → rooms → beacons.

## Available Rooms

| Room | Path | Purpose |
|------|------|---------|
| Research | <HOME>/rooms/research/ | Literature review, data gathering, analysis |
| Writing | <HOME>/rooms/writing/ | Drafting, editing, long-form documents |

## Active Projects

| Project | Path | Status |
|---------|------|--------|
| example-project | <HOME>/workspace/example-project/ | Active |

## Per-Area Constraints

- **Research**: All claims cited. Raw data stays in the data layer.
- **Writing**: Consistent style. Drafts require review before final use.

## Core Directives

1. Never ingest raw data directly into your primary context window.
2. Never traverse outside the environment root unless explicitly asked.
3. Use the compaction workflow: research.md → plan.md → execute from the plan.
4. Knowledge layer: ON. Data layer: ON. Maintenance loop: ON.
5. Destructive cleanup (tidy) is opt-in — never auto-runs.

## Security

- Root scope: <HOME> — all file operations must resolve within this prefix.
- Secrets: ~/secrets/ only, 600 permissions, never committed.
