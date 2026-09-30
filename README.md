# Harbor

[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.1+-black.svg)](https://bun.sh)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-orange.svg)](#connecting-an-agent)

**Harbor** is a control plane for AI coding agents: it decides which **skills**
and tools an agent may reach, how many tokens it may spend, and keeps an audit
trail of what it was refused. Agents talk to it over the Model Context Protocol
(MCP); the enforcement happens inside Harbor, not in the agent's prompt.

The npm package and library import is **`harbor-tugboat`**; the binary command is
**`harbor`**.

Harbor runs in two shapes from one codebase:

| | **Harbor Core** | **Harbor Server** |
|---|---|---|
| For | one operator, one machine | a team or a hosted service with many tenants |
| Agent connects via | stdio (`harbor mcp-server`) | HTTPS (`POST /mcp`, bearer token) |
| Identity | the launching environment (`AGENT_ENV_ROOM`) | a token bound to `(tenant, room)` |
| State | `~/.agent-env`, `~/rooms`, `~/.agents/skills` | one directory tree per tenant |
| Start | `harbor install --for <agent> --write` | `harbor serve` / `docker compose up` |

Server operation — self-hosted or as a hosted offering — is documented in
**[docs/CLOUD.md](docs/CLOUD.md)**. The reasoning behind it is in
**[docs/PLAN_cloud-ready.md](docs/PLAN_cloud-ready.md)**.

## What it does

- **Rooms and capability gating.** Work is organised into rooms (`legal`,
  `devops`, …). Each room has a skill allowlist and a capability set. A session
  in one room asking for another room's skill is refused, and the refusal is
  audited. Unknown rooms fail closed.
- **Sensitivity labels.** Skills carry a tier (`public` < `internal` <
  `restricted`) from the operator's config; a token can carry a ceiling, and a
  skill above it — or unlabeled — is never delivered to it and never listed. This
  is how a person's own agent is kept from receiving what the house agent may.
- **Token budgets.** Loading a skill debits the session's budget atomically
  (SQLite `BEGIN IMMEDIATE`); an overspend is refused, never silently absorbed.
  Token counts are estimated as characters ÷ 4.
- **House agent acting per person.** A `--delegate` token can do nothing on its
  own: each request names the person it acts for (`Harbor-On-Behalf-Of`) and that
  person's grant decides the room, sensitivity and quotas — re-read every request.
  It bounds what a house agent can hand someone; it cannot verify who is asking. A
  reference client (`integrations/delegate-client`) refuses any person that did not
  come from an authenticated channel identity.
- **Audit log.** Every denial (and privileged allowance) is recorded in SQLite:
  who, which room, which capability, which resource, why.
- **Skill pool with progressive disclosure.** Skills live once in a pool and are
  granted to rooms. Agents get a lean index first and load full `SKILL.md` text
  on demand, so context is spent only on what the task needs.
- **Turn-Sieve (`route_skills`).** An agent describes its task and gets back the
  one to three skills of *its own room* that fit (up to five if the task spans
  domains). It uses the optional System One router when reachable and
  deterministic keyword matching otherwise; the answer says which. See
  [below](#system-one-and-the-turn-sieve).
- **Room path sandbox.** Containment for files, data and child processes is
  checked with `realpath`, so a symlink planted in a room, or `link/../x`, does
  not escape it. See `src/sandbox.ts`.
- **Also included:** a priority-queue task scheduler with per-room daily budgets,
  a deterministic context-compaction engine (LRU eviction to a SQLite archive),
  session tracking, a human-approval gate for cross-room loads, a keychain-backed
  secrets helper, a beacon watcher that keeps `AGENTS.md` / `CLAUDE.md` /
  `.cursorrules` in sync, and a health dashboard.

### Honest limits

Harbor is **cooperative, tool-level enforcement**. It governs what an agent can
do *through Harbor's tools*. It does not confine a process that can open files
directly, and a path check cannot close a check-then-use race or a hard link. In
Server mode identity comes from a credential, the server exposes no file or shell
tools, and each tenant's state lives under its own root — but run it as an
unprivileged user in a container for the OS-level layer. Token budgets are cost
control, not a hard quota. `docs/SPEC_hardening.md` and `docs/CLOUD.md` state
the boundaries in full.

## Quickstart — Harbor Core

```bash
git clone <this repository> && cd Harbor
bun install
bun run build                      # optional: single binary at dist/harbor

harbor init                        # seed agent_map.md and the AGENTS.md / CLAUDE.md beacons
harbor setup                       # build the directory tree from config
harbor check                       # read-only health check

harbor install --for claude-code            # print the MCP config (safe dry run)
harbor install --for claude-code --write    # apply it (backs the file up first)
```

Without the build step, run `bun src/cli.ts <command>` wherever this file says
`harbor <command>`.

Agents supported by `harbor install --for`: `claude-code`, `cursor`, `opencode`,
`codex`, `gemini`, `goose`, `antigravity`, `pi` (in-process), and `orchestrator`
(one connection per room).

### Connecting an agent

A stdio agent is launched with its room in the environment:

```bash
AGENT_ENV_ROOM=legal harbor mcp-server
```

The MCP server exposes: `route_skills`, `search_skills`, `list_skills`,
`read_skill`, `activate_skill`, `deactivate_skill`, `list_rooms`,
`budget_status`, `audit_recent` — each gated by the session's room and budget. On a
Server session `audit_recent` shows only that session's rows and needs the
`audit_read` capability, which no room has by default.

## Quickstart — Harbor Server

```bash
docker compose up -d
docker compose exec harbor bun src/cli.ts tenant create acme
docker compose exec harbor bun src/cli.ts tenant add-room acme --room legal
# install a skill (see docs/CLOUD.md), then:
docker compose exec harbor bun src/cli.ts token create --tenant acme --room legal
```

Then point an MCP client at `https://<your-host>/mcp` with
`Authorization: Bearer <token>`. Put a TLS-terminating proxy in front — a
Caddy example is included (`docker compose --profile tls up -d`). Full guide:
[docs/CLOUD.md](docs/CLOUD.md).

## System One and the Turn-Sieve

System One is an optional, small, non-generative router daemon that decides which
of a room's skills a task needs. **The daemon is not part of this repository**;
Harbor ships the client and the trust boundary around it.

- Default endpoint `http://127.0.0.1:8150` (`HARBOR_SYSTEM_ONE_URL`, or
  `[system_one] url` in `config.toml`); `POST /v1/route-skills`. Port `8000` is
  reserved and refused.
- Its answer is **untrusted advice**: names are intersected with the room's own
  skills (a daemon naming another room's skill gets it dropped and audited), the
  reply is size-capped, redirects are refused, and any failure falls back to
  keyword matching.
- At most **3 skills per turn**, **5** only when the daemon flags the turn
  cross-domain — never because the prompt asks for more.
- `harbor service print --unit system-one --command "<your daemon's command>"`
  renders a launchd or systemd definition so it starts at boot. Harbor works
  without it.

## Command reference

`harbor <command> --help` for details. Every command accepts `--config <toml>` or
`--root <dir>` to select the environment.

| Area | Commands |
|---|---|
| Environment | `init`, `setup`, `check`, `sync`, `watch`, `start`, `stop`, `dashboard` |
| Skills | `skills-list`, `skill-create`, `skill-install`, `skill-assign`, `skill-room-add`, `skill-update`, `skill-remove` |
| MCP config | `mcp-server`, `install`, `mcp-add`, `mcp-remove`, `mcp-check`, `mcp-gen`, `mcp-merge` |
| Enforcement | `isolation` (`check`, `rooms`, `audit`, `denials`, `doctor`), `gate`, `budget`, `audit`, `approval`, `spawn` (`--confine` pins the child to its room) |
| Runtime | `scheduler`, `compaction`, `session`, `bench` |
| Secrets | `secrets` (`set`, `get`, `list`, `rm`, `export`, `doctor`) |
| Server | `serve`, `tenant` (`create`, `add-room`, `list`, `suspend`, `resume`), `token` (`create`, `list`, `revoke`; `--principal`, daily quotas, `--max-sensitivity`, `--delegate`), `principal` (`list`, `suspend`, `resume`, `revoke`, `grant`, `ungrant`, `grants`), `service print` |
| Labels | `label` (`set`, `clear`, `list`) — sensitivity tiers for rooms and skills; a token with `--max-sensitivity` is never handed a skill above it, or an unlabeled one |
| Sharing | `proposal` (`list`, `show`, `approve`) — install a skill from a shared folder only if it is exactly what you reviewed; `guard <folder>` — scan for credentials and never-sync files before a folder is shared (never prints the secret) |

`harbor dashboard` serves on loopback by default. Binding it elsewhere requires
`HARBOR_DASHBOARD_TOKEN` (at least 16 characters); the token is read from the
environment, never from argv.

## Development

```bash
bun install
bunx tsc --noEmit      # typecheck
bun test               # full suite
```

`scripts/smoke.sh local` starts a real `harbor serve` and checks it end to end
(`scripts/smoke.sh docker` does the same against the container image).

CI also runs a de-personalization scan that fails the build if a user-home path
appears in shipped source or docs.

## Documentation

- [docs/CLOUD.md](docs/CLOUD.md) — running Harbor Server (self-hosted or hosted)
- [docs/PLAN_cloud-ready.md](docs/PLAN_cloud-ready.md) — audit, decisions, plan
- [docs/SPEC_hardening.md](docs/SPEC_hardening.md) — secrets, approval gate, pool isolation
- [docs/ROADMAP_reconcile-and-consistency.md](docs/ROADMAP_reconcile-and-consistency.md), [docs/ROADMAP_harbor-team.md](docs/ROADMAP_harbor-team.md), [docs/PROXY_SCOPE.md](docs/PROXY_SCOPE.md), [docs/BUZZ.md](docs/BUZZ.md)

---

## 📄 License & Attribution

Copyright © 2026 TDH Labs / Vibherpunk. All rights reserved.  
Harbor core hypervisor and routing algorithms are engineered for sovereign, high-velocity autonomous agent infrastructure.
