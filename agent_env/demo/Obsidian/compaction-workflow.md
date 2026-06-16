---
title: Compaction Workflow
type: concept
domain: methodology
created: 2024-01-01
tags: [workflow, research, planning]
---

# Compaction Workflow

The compaction workflow is a three-phase method for managing agent context
across long research and writing tasks. It prevents context flooding while
preserving the full chain of reasoning.

## Phases

1. **Research** — gather sources, summarize findings, record citations
2. **Plan** — synthesize research into a concrete action plan
3. **Execute** — work only from the plan, never from raw research directly

## Key Numbers

- Maximum context load: keep active context under 50 lines per tool call
- Scratchpad threshold: dump any output over 50 lines to `scratchpad.md`
- Compaction cadence: compact after every major research phase

## Why It Works

The compaction workflow enforces a deliberate bottleneck: the plan is the
only artifact that crosses the research-to-execution boundary. This means
an agent can always reconstruct its context from three small files rather
than a sprawling chat history.

## Related Concepts

See [[five-layer-environment]] for how the compaction workflow fits into the
broader environment architecture. See [[knowledge-base-protocol]] for how
Obsidian notes complement this workflow.

## Sources

- Conceptual synthesis from agent-environment architecture brief
- Informed by structured analytic techniques in intelligence analysis
