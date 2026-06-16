# Beacon Setup Guide

> **What is a beacon?** A beacon is a machine-readable orientation file
> (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) that tells an AI tool how
> to navigate your environment. `agent-env sync` generates all beacons
> from a single source of truth: `agent_map.md`.

## Prerequisites

- Python 3.10+
- `pip install agent-environment`
- macOS or Linux

## First-time setup

```bash
# 1. Run the onboarding interview (≤8 questions, <2 min)
agent-env init

# 2. Build the directory structure from the generated config
agent-env setup --root $HOME

# 3. Verify everything is healthy
agent-env check
```

After `init`, you will have:
- `$HOME/agent_map.md` — your routing map and single source of truth
- `$HOME/.agent-env/config.toml` — machine settings
- `$HOME/AGENTS.md`, `$HOME/CLAUDE.md`, `$HOME/.cursorrules` — beacon files

## Try the demo first

If you want to explore the structure before committing to your real home:

```bash
agent-env setup --demo /tmp/my-demo-env
cat /tmp/my-demo-env/agent_map.md
cat /tmp/my-demo-env/Obsidian/_index.md
```

The demo creates a fully working 5-layer environment under `/tmp/my-demo-env/`
with generic content. Delete it when you are done:

```bash
rm -rf /tmp/my-demo-env
```

## Directory structure

After setup, your environment looks like this:

```
$HOME/
├── agent_map.md              # ← single source of truth
├── AGENTS.md                 # ← generated beacon (all AGENTS.md readers)
├── CLAUDE.md                 # ← generated beacon (Claude Code)
├── .cursorrules              # ← generated beacon (Cursor)
├── rooms/
│   └── <room>/
│       ├── room_rules.md     # ← domain constraints
│       └── skills_index.md   # ← auto-generated skill list
├── workspace/
│   └── <project>/            # ← active project files
├── data/
│   ├── catalog.md            # ← auto-generated data catalog
│   └── <db>/
│       ├── <db>.db           # ← SQLite database
│       └── README.md         # ← schema + query examples
├── Obsidian/
│   ├── _index.md             # ← auto-generated note index
│   └── <note>.md             # ← Gbrain Protocol notes
└── .agent-env/
    ├── config.toml           # ← machine settings
    └── version               # ← schema version stamp
```

## Editing agent_map.md

All beacons derive from `agent_map.md`. Edit it directly, then regenerate:

```bash
# Edit the map
$EDITOR $HOME/agent_map.md

# Regenerate all beacons immediately
agent-env sync
```

### Adding a room

Add a row to the `## Available Rooms` table:

```markdown
| My Room | ~/rooms/my-room/ | What this room is for |
```

Then create `~/rooms/my-room/room_rules.md` with your constraints.

### Adding a project

Add a row to the `## Active Projects` table:

```markdown
| my-project | ~/workspace/my-project/ | Active |
```

Or use the CLI helper:

```bash
agent-env new-project my-project --room my-room
```

## Keeping beacons fresh

Run a full sync at any time:

```bash
agent-env sync
```

For automatic syncing on file changes, start the watcher daemon:

```bash
agent-env start        # start daemon (writes ~/.agent-env/watcher.pid)
agent-env stop         # stop daemon
```

Or run it in the foreground:

```bash
agent-env watch        # Ctrl-C to stop
```

For a periodic full sync via cron (recommended as a backstop):

```bash
# Add to crontab (runs every 6 hours)
crontab -e
# Add this line:
0 */6 * * * agent-env sync --config $HOME/.agent-env/config.toml
```

## Migrating from a prior beacon setup

If you previously used another tool (Hermes, Goose, n8n, a custom cron script, or any
agent framework with a built-in sync loop) to manage your beacon files, you must disable
**all** of those schedulers before switching to agent-env — not just the system cron.

Many agent and automation tools have their own internal sync loops that run independently
of cron and launchd. If any of them continue to overwrite your beacon files, agent-env's
stamps will be lost on the next run, `agent-env check` will warn about missing stamps, and
the agents will read whichever tool ran last.

Checklist before running `agent-env sync` for the first time:

- [ ] **System cron** — `crontab -l` and remove any beacon-sync entries
- [ ] **launchd** (macOS) — `launchctl list | grep <tool>` and unload the plist
- [ ] **Hermes** — disable or remove the Hermes beacon-sync schedule
- [ ] **Goose** — disable any Goose-managed beacon updates
- [ ] **n8n / other automation** — turn off any workflows that write `AGENTS.md`,
      `CLAUDE.md`, or `.cursorrules`
- [ ] **Any other tool** — check for running processes: `ps aux | grep -i beacon`

After disabling competing schedulers, run `agent-env sync` once, then verify:

```bash
agent-env check   # should show PASS with no "lacks agent-env sync stamp" warnings
```

## Multiple machines

Each machine has its own `config.toml` (in `~/.agent-env/`) with its own
paths and skip lists. The `agent_map.md` can be shared (e.g., synced via a
dotfiles repo), but each machine's config is local.

Run `agent-env init` on each new machine. The interview detects an existing
`~/.agent-env/config.toml` and asks whether to start fresh (overwrites the
existing config) or abort — there is no re-use / merge option yet.

## Troubleshooting

### Check reports errors

```bash
agent-env check
```

Common issues:
- **Map missing tables**: `agent_map.md` must have `## Available Rooms` and
  `## Active Projects` sections with valid markdown tables
- **Beacon stale**: run `agent-env sync`
- **Schema version mismatch**: run `agent-env migrate` (Phase 6)

### Reset the environment

To start over cleanly:

```bash
agent-env teardown --root $HOME   # removes only what setup created
agent-env init                    # run the interview again
agent-env setup --root $HOME
```

## Config reference

`~/.agent-env/config.toml` controls all behavior. Key settings:

```toml
[paths]
home       = "/home/<user>"      # environment root
skills_dir = "~/.agents/skills"  # shared skill pool

[discovery]
scan_home  = true                # scan home for project candidates
skip_list  = ["Downloads", ...]  # never offer these in scan

[beacons]
home_targets = ["AGENTS.md", "CLAUDE.md", ".cursorrules"]

[tidy]
enabled = false   # destructive hygiene is OFF by default (decision #7)
                  # enable only when you are ready: tidy.enabled = true
```

For a full annotated template, see `agent_env/config.template.toml`.
