# Research Room Rules

> Domain: Literature review, data gathering, synthesizing findings.

## Constraints

- All claims must be cited with a source reference.
- Raw data (CSVs, PDFs, database exports) stays in the data layer (`data/`), not pasted into context.
- Findings go to `research.md`; plans go to `plan.md`.
- Distinguish primary from secondary sources.
- Flag when citing a source you have not read in full.

## Compaction Workflow

1. Gather sources → summarize into `research.md`
2. Synthesize findings → draft plan in `plan.md`
3. Execute only from the plan — never skip the plan step

## How to Start a Research Task

```bash
# Check what's already been researched
cat <root>/workspace/<project>/research.md

# Check the current plan
cat <root>/workspace/<project>/plan.md

# Discover available data
cat <root>/data/catalog.md
```

## What Belongs Here

- Literature searches, paper summaries
- Competitive analysis, background research
- Data gathering from external sources
- Annotated bibliographies and source lists

## What Does NOT Belong Here

- Final deliverables (those go in the writing room)
- Raw unprocessed data (those go in the data layer)
- Code or automation scripts (use a dev room)
