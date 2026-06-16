# AGENTS.md — Machine Orientation for AI Agents

> **READ THIS FILE FIRST.** It is the entry point to this machine's cognitive architecture.

## Quick Orientation

This machine uses a **5-layer structure** for AI agent context:

1. **The Map:** `<HOME>/agent_map.md` — Global routing, room index, project table, security boundaries
2. **The Rooms:** `<HOME>/rooms/<domain>/` — Domain-specific rules, skills, and constraints
3. **The Workspace:** `<HOME>/workspace/<project>/` — Active project files, compaction artifacts
4. **The Data Layer:** `<HOME>/data/` — Structured, queryable data (SQLite + catalog.md)
5. **The Knowledge Base:** `<HOME>/Obsidian/` — Conceptual, cross-linked notes ([[wikilinks]])

## Startup Protocol

Before doing any work, follow this sequence:

1. **Read the Map:** `cat <HOME>/agent_map.md`
2. **Identify your task's room** from the room index in the map
3. **Read the room rules:** `cat <HOME>/rooms/<domain>/room_rules.md`
4. **If skills are relevant:** `cat <HOME>/rooms/<domain>/skills_index.md`
5. **Navigate to the workspace:** `cd <HOME>/workspace/<project>/`

## Core Rules

- **Never work out of `~/Downloads/`** — move files to the appropriate workspace first
- **Never traverse outside `<HOME>/`** unless explicitly asked
- **Secrets are in `~/secrets/`** — gitignored, 600 permissions, only read when needed for an API call
- **Large tool outputs (>50 lines):** dump to the project's `scratchpad.md` and read iteratively
- **Compaction workflow:** Research → `research.md` → Synthesize → `plan.md` → Execute from plan only

## Data Layer (Structured Data)

Structured data that doesn't fit the file tree lives in `~/data/` as SQLite databases.
Read `~/data/catalog.md` to discover available databases, schema, and query examples.
Each database has a README.md with full documentation.

```bash
# Discover databases
cat ~/data/catalog.md
# Query a database
sqlite3 ~/data/<domain>/<domain>.db "SELECT * FROM <table> LIMIT 5;"
```

## Knowledge Base (Obsidian Vault)

Conceptual knowledge that connects ideas lives in `~/Obsidian/` — deal notes, SOPs, research synthesis.
Use bidirectional `[[links]]` to connect concepts. Templates are in `~/Obsidian/_templates/`.

```bash
# Discover knowledge domains
ls ~/Obsidian/
# Read a knowledge note
cat '~/Obsidian/<folder>/<note>.md'
```

## MANDATORY: Skill Loading Before Tasks

Before starting ANY task, you MUST:
1. **Identify the domain** → which room does this task belong to?
2. **Read the room's skills_index.md** → `cat ~/rooms/<domain>/skills_index.md`
3. **Load ALL relevant skills** → if 2 or 3 skills match your task, load them ALL
4. **Then start work** — never begin a task without checking for applicable skills first

Multiple skills often apply to a single task — e.g. a reconciliation task might pull in a bookkeeping skill AND a data-cleaning skill AND a spreadsheet-audit skill. Load every relevant skill for the task before starting.

## Skill Storage

Skills live in `<HOME>/.agents/skills/` — the shared pool agents read from. Use progressive disclosure:
- **Map:** This file shows room → skill counts
- **Room:** `~/rooms/<domain>/skills_index.md` has skill names + descriptions
- **Detail:** `cat <HOME>/.agents/skills/<name>/SKILL.md` — load only what you need

## Room Index

| Room | Path | When to Enter |
|------|------|---------------|
| Research | <HOME>/rooms/research/ | Literature review, data gathering, analysis |
| Writing | <HOME>/rooms/writing/ | Drafting, editing, long-form documents |

## Project Index

| Project | Workspace Path | Status |
|---------|---------------|--------|
| example-project | <HOME>/workspace/example-project/ | Active |

Each workspace has a `project` symlink pointing to the original codebase location.

## Security

- **Root scope:** `<HOME>/` — all file operations must resolve within this prefix
- **Secrets vault:** `~/secrets/` — never committed, never read into context unless making a specific API call
- **Blocked paths:** Never write to `/System/`, `/Library/`, other user home dirs
- **Downloads:** Staging only. Move to workspace before processing.

<!-- agent-env:sync -->