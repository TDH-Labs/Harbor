# Roadmap: `harbor team` — a portable agentic technical team

> Status: proposed design. Origin: a real build session that assembled a
> senior-engineer agent harness (one-command `architect "<request>"` over a
> 17-agent / 13-role swarm with a hard-verify loop, critic cluster, and
> beacon-driven skill routing). This doc generalizes that machine-specific
> assembly into a portable Harbor primitive.

## Goal

Let a non-technical operator install a **team** — a coordinated set of agent
roles, the skills they reach, and the gates that constrain them — and get
senior-engineer *process* out of it: grill the fuzzy request into a spec, build,
**prove it works**, refactor, and refuse to ship what fails. The team binds to
whatever model subscription the operator has, on whatever machine.

## The core principle: gates vs. judgment

The originating session proved this live. Asked to dry-run a trivial build, the
agent **skipped** the PRD and methodology ceremony and went straight to
build→verify — and that was *correct*; a senior engineer doesn't write a PRD for
a 10-line file. The hard gates held (verify passed 3×, DONE recorded with
evidence); the "mandatory" load-order steps were treated as judgment and rightly
bypassed.

Lesson that drives this whole design:

- **Gates** are enforceable, transferable, and the real product. (verify must
  pass; deploy blocked without the pass sentinel; budget debits on the hot path.)
- **Judgment** is a *nudge* the stance prompt provides but cannot guarantee. The
  agent will optimize an explicit user instruction over a "mandatory" stance step.

So a portable team ships **gates as enforceable skills** and treats the stance as
a nudge, not a contract. This mirrors Harbor's own philosophy — *make the
cooperative path the easy, observable, budgeted one.*

## What generalizes vs. what doesn't

| Generalizes → ship in the bundle | Per-machine / per-project → bind or scaffold |
|----------------------------------|----------------------------------------------|
| Senior-engineer stance prompt | Model assignments (tied to a subscription/key) |
| Hard-verify loop + pass sentinel | The project's `verify.sh` (what "works" means) |
| Critic cluster (drift/hallucination/oversight) | Domain make-vs-procure & compliance judgment |
| Beacon-read routing directive | API keys, provider limits |
| Room→skill taxonomy | |
| Phase-gate pattern (file-backed status) | |
| Role manifest **by archetype, not model name** | |

The honest ceiling: a turnkey team gets an operator to ~70–80% — a working,
verified, reasonably-structured build with the obvious gates enforced. The
residual is domain judgment, which stays a human-in-the-loop checkpoint rather
than a hallucinated guarantee. **Do not market the residual as automated.**

## Bundle format

A team is a directory (installable, versionable, shareable) Harbor reconciles
against the local machine:

```
<team-name>/
  team.toml            # manifest: roles, rooms, gates, stance ref
  stance.md            # the senior-engineer framing (a nudge, parameterized)
  verify.template.sh   # the hard-verify contract, project-parameterized
  rooms/               # room rules + skills_index seeds this team needs
  skills/              # skills this team ships (gate skills live here)
```

### `team.toml`

```toml
[team]
name = "senior-eng"
version = "0.1.0"
description = "Grill → spec → build → hard-verify → refactor, with gates."

# Roles are described by ARCHETYPE + CAPABILITY, never by a concrete model.
# `harbor team bind` resolves each to the best available local model.
[[roles]]
id = "architect"
purpose = "Grill the request into an unambiguous spec; own scope."
archetype = "deepest-reasoning"      # capability requirement, not a model
min_context = 100000
rooms = ["superpowers"]              # beats this role works in

[[roles]]
id = "coder"
purpose = "Implement against the spec."
archetype = "strong-code"
rooms = ["devops", "superpowers"]

[[roles]]
id = "test_engineer"
purpose = "Author + run the hard-verify gate."
archetype = "test-fix-loop"
rooms = ["devops"]

[[roles]]
id = "critic_oversight"
purpose = "Final say on DONE; refuse on missing evidence."
archetype = "deepest-reasoning"
rooms = ["superpowers"]

# Gates are ENFORCED, not suggested. Each maps to a skill that can fail-stop.
[[gates]]
id = "hard-verify"
skill = "hard-verify-loop"
blocks = "done"                      # cannot record DONE without the pass sentinel
runs = 3                             # multi-run: catch flakiness/races

[[gates]]
id = "deploy-gate"
skill = "deploy-gate"
blocks = "deploy"                    # blocks push/deploy without HARD_VERIFY_PASS

[scaling]
# Scale the team to the task — don't spin up 13 roles for a hello-world.
default_profile = "minimal"          # architect + test_engineer
escalate_to = "full"                 # full cluster when the PRD signals complexity
escalate_when = "prd.complexity >= medium"
```

### Archetype → model binding (the portability layer)

`harbor team bind <team>` resolves every `archetype` to a concrete model from the
machine's available providers, writes the binding to local state, and **surfaces
provider errors loudly** (the origin session lost time to a silent usage-limit
hang). Archetypes are a small closed vocabulary:

| Archetype | Selects for | Example fallback chain |
|-----------|-------------|------------------------|
| `deepest-reasoning` | max think depth, NL→intent | best→mid reasoning model |
| `strong-code` | code accuracy/efficiency | best code model |
| `test-fix-loop` | break→fix iteration | code model w/ tool use |
| `fast-cheap` | high-volume verification passes | cheapest competent model |

Binding is **once per machine**, re-runnable when the subscription changes. The
operator never picks models per build.

## Commands

| Command | What it does |
|---------|--------------|
| `harbor team install <src>` | Install a team bundle: merge its rooms/skills into the pool, register the manifest. |
| `harbor team bind <name>` | Resolve every role archetype to a local model; report unbindable roles loudly. |
| `harbor team verify <name>` | Reconcile: every role bindable? every room/skill present? every gate skill installed? (read-only) |
| `harbor team run <name> "<request>" [--profile minimal\|full]` | Launch the team on a request, gates enforced. |
| `harbor team list` | Installed teams + bind/health status. |

`harbor team verify` is the reconcile primitive from the consistency roadmap,
specialized: it makes the *declared* team agree with the *actual* machine before
a run, so failures surface at install time, not mid-build.

## The highest-leverage piece: a `verify.sh` generator

The whole system hinges on *what does "working" mean* — which a non-technical
operator cannot author from a blank page. The single most valuable artifact is a
generator that reads the PRD and **proposes** observable acceptance checks
("server starts; `/health` → 200; unknown route → 404; idempotent re-run"),
then asks the human to confirm or edit.

This turns the hardest authoring task into a **yes/no review**. It does more for
non-technical upskilling than the rest of the bundle combined — it transfers the
one piece of senior judgment (defining "done" as *observable behavior*, not "the
code looks right") into a guided decision. Ship it as a gate skill
(`verify-author`) the architect role runs at end-of-spec.

## Design rules carried from the session

1. **Lean on gates, not stance.** A deploy-gate that blocks ship without the pass
   sentinel is worth more than any amount of "mandatory" prompt text.
2. **Scale the team to the task.** Default minimal (2 roles); escalate to the full
   cluster only on PRD-signalled complexity. 13 roles on a hello-world is pure
   cost and latency.
3. **Make-vs-procure applies to the team itself.** Prefer mature off-the-shelf
   skills (e.g. the aihero `to-prd → to-issues → tdd` chain) over hand-rolled
   ones; the bundle declares dependencies, it doesn't reinvent them.
4. **Bind-your-own-models.** Never ship concrete model names; ship archetypes.
5. **Fail loud.** Provider limits, unbindable roles, missing gate skills — all
   surface at bind/verify time, never as a silent mid-run hang.

## Honest scope

This is a **process** transfer, not an expertise transfer. It reliably gives an
operator: a grilled spec, a built artifact, a hard-verified "it actually runs,"
and a refusal to ship failure. It does **not** give domain-correct architecture,
compliance posture, or make-vs-procure calls for a specific business — those stay
human-in-the-loop, surfaced as explicit checkpoints the team asks about rather
than silently guesses. Marketed honestly, that boundary is the feature, not the
shortfall.

---

*Build order if only the spine ships: `team.toml` + archetype binding +
`harbor team verify` (reconcile) + the `verify-author` generator. That spine is a
portable, honest senior-engineer process; everything else (full critic cluster,
compliance room, prod-feedback back-edge) layers on as additional gate skills.*
