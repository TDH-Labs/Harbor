---
title: Knowledge Base Protocol
type: concept
domain: methodology
created: 2024-01-01
tags: [knowledge, obsidian, protocol]
---

# Knowledge Base Protocol

The knowledge base protocol governs how notes are created, linked, and
consumed in the Obsidian layer of the five-layer environment. It ensures
that knowledge is discoverable, cross-linked, and machine-readable.

## Note Structure

Every note should include:
- YAML frontmatter (`title`, `type`, `domain`, `created`, `tags`)
- A **Key Numbers** section with quantitative facts
- A **Sources** section with citations
- At least two `[[wikilinks]]` to related notes

## Types of Notes

| Type | Purpose |
|------|---------|
| `concept` | Abstract ideas, frameworks, mental models |
| `metric` | Quantitative measures with benchmarks |
| `protocol` | Step-by-step procedures |
| `reference` | Pointers to external resources |

## Key Numbers

- Minimum wikilinks per note: 2
- Target note length: 200–600 words
- Index refresh cadence: on every `agent-env sync`

## How to Use This Layer

Agents should read `_index.md` first to discover relevant notes, then
`cat` specific notes by title. Do not bulk-load all notes into context.

## Related Concepts

See [[five-layer-environment]] for where this layer sits in the hierarchy.
See [[compaction-workflow]] for how to reference knowledge during a task.

## Sources

- Zettelkasten note-taking method (Luhmann)
- Gbrain Protocol for structured agent-readable knowledge bases
