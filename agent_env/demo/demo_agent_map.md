<!-- agent-env schema: 1.0 -->
# Agent Core Map & Routing Protocol

> **Demo environment.** This is a generic example created by `agent-env setup --demo`.
> Run `agent-env init` to build a real environment tailored to your work.
> Edit this file; run `agent-env sync` to regenerate all beacons.

## Host Profile

- Machine: demo-host
- Industry: General (demo)
- Organization mode: both

## Architectural Overview

This environment uses a 5-layer structure for agent context:
knowledge → data → workspace → rooms → beacons.

## Available Rooms

| Room | Path | Purpose |
|------|------|---------|
| Research | <root>/rooms/research/ | Literature review, data gathering, analysis |
| Writing | <root>/rooms/writing/ | Drafting, editing, long-form documents |

## Active Projects

| Project | Path | Status |
|---------|------|--------|
| example-project | <root>/workspace/example-project/ | Demo |

## Per-Area Constraints

- **Research**: All claims cited. Raw data stays in the data layer, never in context.
- **Writing**: Consistent style. Drafts require review before final use.

## Core Directives

1. Never ingest raw data directly into your primary context window.
2. Never traverse outside the environment root unless explicitly asked.
3. Use the compaction workflow: research.md → plan.md → execute from the plan.
4. Knowledge layer: ON. Data layer: ON. Maintenance loop: ON.
5. Destructive cleanup (tidy) is opt-in — never auto-runs.

## Security

- Root scope: <root> — all file operations must resolve within this prefix.
- Secrets: ~/secrets/ only, 600 permissions, never committed.
