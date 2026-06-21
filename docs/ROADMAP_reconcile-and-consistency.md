# Roadmap: reconciliation & state consistency

> Status: proposed. Captures lessons from the first real-world install (alpha
> 0.1.0) on a machine with pre-existing rooms and a live agent. Several bugs
> were found and fixed in that session; this doc records the **pattern behind
> them** and the work that would prevent the next batch.

## Summary

Five bugs surfaced during the first dogfood install:

1. `harbor init` overwrote an existing `agent_map.md` with an empty stub
   (fixed: absent-only guard, commit on `fix: harbor init idempotent …`).
2. `fullSync` never discovered rooms from `~/rooms/` — rooms were manual map
   entries, lost when init wiped the map (fixed: `discoverRooms` +
   `mergeRoomsIntoMap`).
3. `skill-assign` / `skill-install` deadlocked: both required
   `[skills.rooms.<room>]` to pre-exist in config, but no command seeded that
   section from the filesystem (fixed: `ensureRoomInConfig`, filesystem-aware
   room bootstrap).
4. Two parallel assignment mechanisms — `skills.rooms.<room>.skills` (explicit
   list) and `skill_category_to_room` (category map) — with `skill-assign`
   managing only the former and not even reading the latter.
5. `generateRoomIndex` read only the explicit list, so `skills_index.md`
   diverged from what `harbor skills-list --room <room>` reports (fixed:
   route the index through `computeAssignments`).

These are not five unrelated bugs. They are **one architectural gap** appearing
in five places.

## Root pattern

Harbor holds three representations of the same truth — *what rooms exist and
which skills belong to them*:

| Representation | Where |
|----------------|-------|
| Filesystem     | `~/rooms/<name>/`, skills in the pool |
| Config         | `[skills.rooms.*]`, `skill_category_to_room` |
| Beacon/indexes | `agent_map.md`, per-room `skills_index.md` |

Every bug was a command that read one representation, wrote a second, and
**assumed the third was already correct**. `init` wrote the beacon and assumed
nothing else cared. `skill-assign` wrote config and assumed rooms were already
in it. `generateRoomIndex` read one config key and ignored the other.

**No operation owns the job of making the three agree.** Every fix in the
dogfood session was hand-reconciliation.

## Proposed work

### 1. `harbor reconcile` (the missing primitive)

A single command that takes the **filesystem as ground truth** (rooms on disk,
skills in the pool) and makes config + beacon + indexes consistent in one pass:

- seed `[skills.rooms.<room>]` for every `~/rooms/<name>/room_rules.md`
- merge discovered rooms into `agent_map.md` (already in `fullSync`)
- regenerate every `skills_index.md` from `computeAssignments`
- report drift it corrected (and drift it can't, e.g. a config room with no
  directory)

This collapses bugs 1–5 into one operation and gives operators a "make it
consistent" button instead of guessing which command owns which file.

### 2. One source of truth for "skills in room X"

`generateRoomIndex` now routes through `computeAssignments`; **every** consumer
must. Audit for any remaining direct reader of `roomSkillSet` — each is a future
divergence bug. Stretch goal: collapse the explicit-list / category-map duality,
or make the category map the only writable surface and the explicit list a
derived cache.

### 3. Non-destructive by default — as a rule with tests

`init` was destructive where its sibling `setup` was idempotent, for no reason.
Rule: **any command that writes a file a human or another tool may own must be
absent-only or merge, never overwrite.** This deserves a test per command, not
case-by-case discovery when it bites a live machine.

### 4. Defend the beacon, don't just stamp it

Harbor writes `<!-- agent-env:sync -->` and already *knows* an unstamped file
means a foreign tool overwrote it — but only uses that to recognize the file,
never to protect it. The watcher and external tooling can both write
`agent_map.md`; today that's resolved by convention. The tool could detect the
foreign write, warn, and offer to reconcile.

### 5. `harbor doctor`

First-run friction (npm global bin off `PATH`, the `${AGENT_ENV_ROOM}` MCP
validator warning) argues for a health command that checks: bin on `PATH`, MCP
wired, env vars resolvable, watcher running, config/filesystem/beacon in sync.

## The process lesson

**367 green tests caught none of these.** Every bug surfaced within an hour of
installing on a real machine with pre-existing rooms and a live agent. The tests
passed because they used clean throwaway dirs with config **pre-seeded** — they
tested the exact preconditions real life violates. The skill-assign deadlock
even had a passing test (happy-path only; never asked "what if the precondition
isn't met?") — the same tautology class as the Phase 5 gate audit's `list_skills`
finding.

Two follow-ups:

- **Add a "dirty machine" fixture**: populated `agent_map.md`, rooms on disk but
  absent from config, both assignment mechanisms live. Run the suite against it.
  That single fixture would have gone red on four of the five bugs.
- **Extend mutation-testing discipline** from "is the output right" to "does the
  command's *assumed precondition* hold, and what happens when it doesn't."

## Secondary / backlog

- **Tier 2 progressive loading**: the in-process (Pi) path loads full skill
  content on demand but has no index → digest → full tiering — that's Tier 1
  (MCP) only today. The in-process extension could implement tiering itself
  (track served-state per skill) rather than waiting on the host to speak MCP.

---

*If only one thing ships: `harbor reconcile` + the dirty-machine fixture. The
command turns five hand-fixes into one operation; the fixture stops the next
five from reaching a live machine.*
