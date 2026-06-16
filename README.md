# agent-env

[![CI](https://github.com/adamrmatar/Harbor/actions/workflows/test.yml/badge.svg)](https://github.com/adamrmatar/Harbor/actions/workflows/test.yml)
[![PyPI](https://img.shields.io/pypi/v/agent-environment)](https://pypi.org/project/agent-environment/)

**Per-repo instructions files give you one repo. agent-env gives every agent the whole machine.**

I built agent-env to run my own work. Every agent I use — Claude Code, Codex, Gemini, Goose, Cursor — reads the same map: a handful of domain rooms, a dozen-plus projects, a shared pool of a few hundred skills, and databases they can query directly. Each session picks up from the same ground truth instead of booting blank.

The problem it solved was context. My skill pool had grown to where loading it dumped ~40,000 tokens into every new session, on every agent, before any real work started — and the agents still drifted from each other. agent-env flipped that: a session now loads ~5 KB to orient, then pulls only the room the task needs. A fraction of the context, faster responses, one source of truth across every tool.

It's the layer the agentic stack has been missing — the only setup that sits *under* every tool you run instead of inside any one of them. The rules were never inside the tool to begin with; agent-env is where they actually live.

Here's the file every agent reads first — an illustrative example; yours is written from your own answers:

```markdown
# Agent Core Map & Routing Protocol

> Read this file first on every session.

## Rooms
| Room | Domain |
|------|--------|
| [research](rooms/research/)       | Source gathering, synthesis, market intel |
| [writing](rooms/writing/)         | Drafting, editing, style rules |
| [bookkeeping](rooms/bookkeeping/) | Reconciliation, receipts, ledger work |
| [legal](rooms/legal/)             | Contract review, compliance |
| [devops](rooms/devops/)           | Automation, cron, agent infra |

## Active Projects
| Project          | Room        | Workspace |
|------------------|-------------|-----------|
| q3-report        | research    | workspace/q3-report/ |
| quarterly-close  | bookkeeping | workspace/quarterly-close/ |
| vendor-contracts | legal       | workspace/vendor-contracts/ |

## Data
- `metrics.db` — time series the agents query directly (SQLite)

## Skill Pool
- shared skills, mapped to rooms — agents load only what the task needs
```

Open any agent; it reads that, loads the one room the task needs, and works from real ground truth. No grepping. No context burned on everything this job isn't.

<!-- replace before first release: swap docs/demo.gif for the real recording -->
![agent-env in 90 seconds](docs/demo.gif)

---

## Why this exists

Every agent boots blank — greps around, re-derives your setup, and burns context on work it already did last session. Every tool, every session, nothing sticks.

The standard patch is a per-repo file (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`). It handles *one repo*. It says nothing about the machine above it: which other projects exist, what the rules are for this kind of work, where the real data lives.

The newer all-in-one local agents fix the amnesia — but only inside their own house. Commit to one and your environment becomes a feature of that runtime. An environment shouldn't be a feature of a tool. So this one isn't.

## How it works

One file — the **map** (`agent_map.md`) — is what every agent reads first. It orients from there, then loads only the room or dataset the task calls for. Never everything at once (*progressive disclosure*: ~5 KB to orient, then just what's needed).

| Layer | What lives there |
|-------|------------------|
| **1 · Map** | `agent_map.md` — routing, room index, project table. Read first, by every agent. |
| **2 · Rooms** | `rooms/<domain>/` — domain rules and constraints for this kind of work. |
| **3 · Workspace** | `workspace/<project>/` — active project files and scratch. |
| **4 · Data** | `data/` — SQLite databases the agent can query for real numbers. |
| **5 · Knowledge** | a linked notes vault — cross-referenced concepts the agent can walk. |

Markdown map, folders for rooms, SQLite you can open with anything. Write the rules once; they outlive every tool you switch to.

## Beacons: how each agent finds the map

Claude Code wants `CLAUDE.md`. Cursor wants `.cursorrules`. Others read `AGENTS.md`. Rather than fight that, agent-env drops a **beacon** in each spot, every one pointing back to the same `agent_map.md`. Whatever you open lands in the same environment. Edit the map, run `agent-env sync`, and every beacon regenerates — nothing left pointing at a stale copy.

## Quickstart

**See it work — a throwaway demo, no commitment:**
```bash
pip install agent-environment
agent-env setup --demo ~/agent-env-demo
```

**Build your own — a short interview writes your map from plain answers:**
```bash
agent-env init        # ~6 questions, under 2 minutes
agent-env setup       # builds the environment from your answers
```

**Keep it healthy:**
```bash
agent-env sync        # regenerate beacons + indexes from the map
agent-env start       # background watcher: regenerate on change
agent-env check       # health report: config, map, beacons, symlinks
```

```
<!-- replace before first release: paste real `agent-env check` output from the demo install -->
ok    config valid (schema 1.0)
ok    map        agent_map.md (5 rooms, 3 projects)
ok    beacons    AGENTS.md · CLAUDE.md · .cursorrules
ok    indexes    current
check: PASS (0 errors, 0 warnings)
```

Point your agents at it: see [BEACON_SETUP.md](BEACON_SETUP.md).

## Why it's different

Cloud "AI employee" platforms keep your context on their servers — it walks out the door when you stop paying. The local agent runtimes are genuinely good, but pick one and your environment belongs to that framework. agent-env sits *under* all of them:

- **No LLM at runtime.** It's the environment, not an agent — nothing to authenticate, nothing that breaks when a provider pivots.
- **Agent-agnostic.** Anything that reads a markdown file works. Swap the model, keep the system.
- **Progressive disclosure built in.** Agents load the room they need, not the whole pool.
- **No lock-in.** Markdown, SQLite, symlinks — outgrow it and walk away with everything.

## If you set this up for other people

The painful part isn't the first install — it's the ten installs you're on the hook for, and the ground moving under all of them.

Every agent-env install is the same shape. The domain knowledge for a kind of business — its rooms, its rules, its data layout — is markdown you write once and copy onto any client, whatever agent they run. When something shifts, re-point each install from its one map file. `agent-env check` gives the same health readout everywhere, so a broken client is a diff against a known-good shape, not a memory test.

## Roadmap

The core is deliberately small and dependency-light — markdown, SQLite, symlinks, no LLM at runtime. Bigger capabilities are designed to build *on* that core, not into it:

- **Intake — a door that doesn't guess.** A planned layer where work that *arrives* (a document, an email, a file dropped in a folder) gets classified and routed to the room that owns it — and anything ambiguous is held for a human rather than guessed at. The "I don't know what this is" tray is the point: safe to leave running on work that matters. *(Design stage — not in the current release.)*
- **Room packs** — installable, pre-built rooms (rules + skills + templates) for a given industry, so a new environment starts with domain knowledge instead of a blank map.
- **Cross-machine sync** — keep one environment in step across several machines, without giving up local-first ownership.

## Requirements

Python 3.10+. macOS and Linux. Optionally [`fswatch`](https://github.com/emcrisostomo/fswatch) for instant file-change detection (a 5-second polling fallback runs without it).

## License

MIT.
