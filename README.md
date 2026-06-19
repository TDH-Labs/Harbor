# Harbor

> *Tugboat pulls you into Harbor.*

> ## ⚠️ Alpha — `0.1.0`. Unproven; expect breakage.
> Feature-complete and green in CI, but **not yet validated in real-world use**. Expect bugs
> and **breaking changes between versions** — don't build anything on it yet. During alpha,
> install from a release tarball or straight from this repo
> (`bun add github:TDH-Labs/Harbor`); a published npm release comes at beta. Found something
> off? Please [open an issue](../../issues) — that's exactly what this phase is for.

> Distributed (eventually) on npm as **`harbor-tugboat`** (the package/import name); the CLI
> command it installs is **`harbor`**.

**An agent control plane** — scheduler, compaction, isolation, and session tracking for
AI coding agents, with a universal MCP integration so any MCP-capable agent (Claude Code,
Cursor, OpenCode, Codex, Gemini CLI, Goose) routes its skill access through one gate.

Harbor gives you:

- **Room-gated skill access** — each agent session runs in a *room*; skills and MCP servers
  are scoped to rooms, and access outside the room is denied and audited.
- **In-process budget enforcement** — token budgets are checked and debited with a direct
  function call (`<1ms`), not a subprocess bridge.
- **Context compaction** — LRU eviction with an archive, so a long-running session stays
  inside its token budget.
- **A priority-queue scheduler** — SQLite-backed, budget-aware task dispatch.
- **Session tracking + a live dashboard** — file-based session state with a SQLite rollup,
  served on a local HTTP dashboard with WebSocket updates.

Harbor is built on [Bun](https://bun.sh): one runtime, built-in SQLite, a built-in test
runner, and single-binary compilation.

---

## Install

```bash
# Run without installing (npx resolves the package name)
npx harbor-tugboat --help

# Or install globally — this installs the `harbor` command
npm install -g harbor-tugboat

# Or add to a project
bun add harbor-tugboat
```

The npm package (and import specifier) is **`harbor-tugboat`**; the command it installs is
**`harbor`**. So you install `harbor-tugboat` but run `harbor` — e.g. after a global install,
`harbor --help`. (`npx harbor-tugboat …` runs the same command without installing.)

Harbor runs on **Bun ≥ 1.1**. The `harbor` binary is a Bun program; `npx harbor-tugboat` and
the global install both launch it through Bun.

A standalone, dependency-free binary is also available — see [Single binary](#single-binary).

---

## Quickstart

From a clean machine, three commands stand up a working environment:

```bash
npx harbor-tugboat init     # seed agent_map.md + generate the AI beacons (AGENTS.md, CLAUDE.md, .cursorrules)
npx harbor-tugboat setup    # build the directory tree from config, generate beacons
npx harbor-tugboat check    # read-only health check — reports what's wired and what's missing
```

(Installed globally, these are just `harbor init`, `harbor setup`, `harbor check`.)

By default the environment root is your home directory and state lives under
`~/.agent-env/`. To stand one up somewhere else (e.g. a scratch dir), pass `--root`:

```bash
npx harbor-tugboat init  --root /tmp/my-env
npx harbor-tugboat setup --root /tmp/my-env
npx harbor-tugboat check --root /tmp/my-env
```

`setup` creates the standard tree (idempotent — safe to re-run):

```
<root>/
  agent_map.md          # routing table: rooms + projects
  AGENTS.md             # generated beacon (stamped <!-- agent-env:sync -->)
  CLAUDE.md             # generated beacon
  .cursorrules          # generated beacon
  workspace/            # active project working dirs
  rooms/                # per-room rules + skill indexes
  data/                 # structured/queryable data
  archive/              # evicted-context archive
  .agents/skills/       # the skill pool
  .agent-env/           # state: SQLite DBs, logs, sessions, watcher pidfile
```

Everything is configurable via `config.toml` (default location `~/.agent-env/config.toml`,
or pass `--config <path>`). A machine with no `config.toml` runs entirely on the built-in
defaults — no edits required.

---

## Wire up an agent

`harbor install --for <agent>` **emits** the exact config block to add for an agent and
changes nothing on disk. Review it, then either paste it yourself or re-run with `--write`
(which backs up the existing file first). Harbor never silently mutates a running agent's
config.

```bash
# See the MCP server entry for Claude Code (prints to stdout, writes nothing)
harbor install --for claude-code

# Apply it (backs up the existing config first)
harbor install --for claude-code --write
```

Supported agents:

| Agent       | Integration                | `--for` value  |
|-------------|----------------------------|----------------|
| Claude Code | MCP server (stdio)         | `claude-code`  |
| Cursor      | MCP server (stdio)         | `cursor`       |
| OpenCode    | MCP server (stdio)         | `opencode`     |
| Codex CLI   | MCP server (stdio)         | `codex`        |
| Gemini CLI  | MCP server (stdio)         | `gemini`       |
| Goose       | MCP server (stdio ext)     | `goose`        |
| Pi          | In-process import (Tier 2) | `pi`           |

Once installed, the agent reaches Harbor's gated tools (`read_skill`, `list_skills`,
budget/audit queries) over a single persistent MCP connection. The room and session for a
given launch come from the `AGENT_ENV_ROOM` and `AGENT_ENV_SESSION` environment variables —
set them when you launch the agent.

For Pi (and any TypeScript/JavaScript agent with import-level extensions), use the in-process
path instead — a direct function call, no subprocess:

```ts
import { gate, checkBudget, audit } from "harbor-tugboat";
```

---

## Security model

Harbor is a control plane, not a sandbox. It governs how cooperating agents load skills,
spend budget, and enter rooms — and records every decision. It is not a cage for a hostile
process.

**What Harbor enforces**

- **Gated skill access** — every skill load runs a room + budget + audit check.
- **In-process budgets** — token limits debit on the hot path; no quiet overspend.
- **Full audit trail** — every allow and deny is logged with room, session, and reason.

**Where the boundary ends**

- **Not an OS sandbox.** Harbor doesn't intercept syscalls or lock the filesystem. An agent
  with raw file access can read a skill file directly and skip the gate.
- **Rooms are cooperative.** A session's room comes from `AGENT_ENV_ROOM`, set by whatever
  launches the agent. Harbor trusts it — a process that can rewrite its own environment can
  change its room.
- **Open by default.** A room with no `skills` list allows every skill (`roomSkillAllowed()`
  returns `true`). Gating is opt-in: list skills to restrict a room, leave it empty to allow
  all — so a fresh install is usable, not locked shut.

Harbor makes the cooperative path the easy, observable, budgeted one. It doesn't claim to be
unbypassable OS-level isolation — that's a separate layer, on the roadmap, not in `0.1`.

---

## CLI reference

Run `harbor <command> --help` for full flags. All commands accept the global selectors
`--config <path>` (load a `config.toml`, whose `paths.home` sets the root) and `--root <dir>`
(use built-in defaults rooted at `<dir>`).

**Environment**

| Command | What it does |
|---------|--------------|
| `harbor init` | Seed `agent_map.md` and generate the home beacons. |
| `harbor setup` | Build the directory tree from config; generate beacons. |
| `harbor check` | Read-only health check of the environment. |
| `harbor sync [--generate-only]` | Regenerate beacons (and discover projects unless `--generate-only`). |
| `harbor watch` / `start` / `stop` | Run / daemonize / stop the beacon file watcher. |
| `harbor dashboard [--port N]` | Serve the health dashboard (default port 8765). |

**Agent OS core**

| Command | What it does |
|---------|--------------|
| `harbor scheduler <submit\|list\|stats\|cancel\|run-once\|daemon>` | Priority-queue task scheduler. |
| `harbor compaction <stats\|archive\|retrieve\|list-archive>` | Context compaction + archive. |
| `harbor isolation <check\|rooms\|audit\|denials>` | Capability / room gating + audit. |
| `harbor session <start\|track\|end\|list\|active>` | Agent session tracking. |

**Hypervisor primitives**

| Command | What it does |
|---------|--------------|
| `harbor spawn -- <cmd>` | Spawn a Harbor-owned child (room, budget, timeout). |
| `harbor budget <check\|spend>` | In-process token budget check / debit. |
| `harbor gate <room> <tool> [resource]` | Room-gated capability check. |
| `harbor audit <recent\|denials>` | Hypervisor audit trail. |

**Skills + MCP**

| Command | What it does |
|---------|--------------|
| `harbor skills-list [--room R]` | List pool skills with room assignments. |
| `harbor mcp-check` / `mcp-gen` / `mcp-merge` | Validate / generate / merge per-room MCP configs. |
| `harbor skill-create` / `skill-install` / `skill-assign` | Scaffold / install / route skills. |

**Integrations**

| Command | What it does |
|---------|--------------|
| `harbor mcp-server` | Run the Harbor MCP server over stdio (Tier 1, universal). |
| `harbor install --for <agent> [--write]` | Emit (or apply) an agent's integration config. |

---

## Programmatic use

```ts
import { createSession, checkBudget, spendBudget, audit } from "harbor-tugboat";

const session = createSession({ room: "research", budget: 150_000 });

const allowed = checkBudget(session.id, "some-skill", 5072);
if (allowed.ok) {
  // load the skill, then debit:
  spendBudget(session.id, "some-skill", 5072);
}
```

Subpath exports mirror the modules — `harbor-tugboat/scheduler`, `harbor-tugboat/compaction`,
`harbor-tugboat/isolation`, `harbor-tugboat/budget`, `harbor-tugboat/gate`,
`harbor-tugboat/audit`, `harbor-tugboat/evict`, and more.

---

## Single binary

Harbor compiles to a standalone executable with no Bun or Node.js required on the target:

```bash
bun build --compile --target=bun-darwin-arm64 ./src/cli.ts --outfile harbor-darwin-arm64
bun build --compile --target=bun-linux-x64    ./src/cli.ts --outfile harbor-linux-x64
```

SQLite is bundled (Bun ships it built-in), so the binary is self-contained.

---

## Configuration

Harbor reads `config.toml` (default `~/.agent-env/config.toml`) merged over built-in
defaults. Rooms, room capabilities, per-room MCP servers, token budgets, watch paths, and
skill-pool sources are all config-driven. The shipped defaults are generic — example MCP
servers are `filesystem` and `github`; no personal servers, paths, or room names are baked
in. See `harbor check` and `harbor isolation rooms` to inspect the resolved configuration.

---

## License

[MIT](./LICENSE)
