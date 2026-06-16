# Writing Room Rules

> Domain: Drafting, editing, and publishing long-form documents.

## Constraints

- All drafts require review before being sent or published.
- Maintain a consistent style guide across all outputs.
- Version drafts: keep prior versions in the project workspace before overwriting.
- Claims and statistics must be traceable to research notes or cited sources.
- Flag any AI-generated section that has not been human-reviewed.

## Document Workflow

1. Gather research context from `research.md`
2. Outline in `plan.md` before drafting
3. Draft in the project workspace
4. Review and revise — never send a first draft
5. Archive completed drafts with a date suffix

## How to Start a Writing Task

```bash
# Read the research context
cat <root>/workspace/<project>/research.md

# Check the outline / plan
cat <root>/workspace/<project>/plan.md

# Check the vault for related concepts
cat <root>/Obsidian/_index.md
```

## What Belongs Here

- Long-form documents, reports, articles
- Editing and proofreading passes
- Style and tone review
- Publication-ready outputs

## What Does NOT Belong Here

- Raw research notes (those go in the research room)
- Data analysis scripts (those go in a dev room)
- Unreviewed AI drafts marked as final
