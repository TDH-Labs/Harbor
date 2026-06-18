# Phase 5 — Agent Integrations (builder notes)

The integration surface that makes Harbor work with real agents. Two tiers plus
the install command:

| Module | What it is | Public surface |
|--------|-----------|----------------|
| `integrations/mcp-server.ts` | Tier 1 — universal stdio MCP server (JSON-RPC 2.0) | `createMcpServer(opts)`, `runStdioServer(server, input?, write?)`, `TOOL_DEFINITIONS`, `MCP_PROTOCOL_VERSION` |
| `integrations/pi.ts` | Tier 2 — in-process import for Pi | `default` extension fn, `registerHarborSkills(pi, opts)`, `readSkill(ctx, name)`, `listSkillsTool(ctx, room?)`, `piContext(opts)` |
| `src/install.ts` | `harbor install --for <agent>` config emission | `emitSnippet(agent, opts)`, `applyConfig(agent, opts)`, `renderSnippet(format, ctx)`, `AGENT_IDS` |

Subpath exports added to `package.json`: `harbor/install`,
`harbor/integrations/pi`, `harbor/integrations/mcp-server`. The install API is
also re-exported from `index.ts`. The two integrations are reached via their
subpath exports (they `import { … } from 'harbor'` themselves, so they are not
pulled into the core `index.ts` static graph).

CLI subcommands added (citty): `mcp-server` (stdio server), `install` (emit; or
`--write` to apply with a backup).

## MCP server design — no SDK, hand-rolled stdio JSON-RPC

No `@modelcontextprotocol/sdk` dependency: the stdio transport is line-delimited
JSON-RPC 2.0, implemented directly (~split-on-newline → `JSON.parse` → dispatch →
`JSON.stringify`). This keeps the package dependency-free, the single-binary
`bun build --compile` self-contained, and the server trivially testable (feed it
JSON lines, read JSON lines — no process needed). Protocol revision pinned at
**`2025-06-18`**, verified at build time against the live MCP spec lifecycle doc.

Methods handled: `initialize`, `notifications/initialized` (no reply), `ping`,
`tools/list`, `tools/call`. Unknown methods → JSON-RPC `-32601`; malformed lines →
`-32700`; the loop never dies. Tools: `read_skill`, `list_skills`, `budget_status`,
`audit_recent`. Room-gating and budget enforcement happen INSIDE the server via
Phase 3's `gate()` / `checkBudget()` / `spendBudget()` / `audit` — the agent never
sees the ungated path.

## Per-session gate context — the Phase 3 concurrency contract (pinned)

Every request that touches a session runs inside `runWithGateContext` (the Phase 3
`AsyncLocalStorage` scope), seeded from `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION`. The
tools read their session from `currentGateContext()` (the ALS store), never from a
shared module global — so concurrent requests for different sessions interleaved in
one process can never read each other's room or budget. This is the exact fail-open
class that NO-GO'd Phase 3.

`integrations/mcp-server.concurrency.test.ts` pins it with two checks:

1. **ALS-across-await discriminator** (the real fail-open detector). N gated chains,
   each bound to its own session, all suspend at a shared barrier, then resume and
   read `currentGateContext()`. With AsyncLocalStorage each chain reads its OWN
   room; with a module-global "current context" every chain reads the LAST-bound
   room → RED. **Mutation-verified**: temporarily replacing `runWithGateContext` /
   `currentGateContext` with a shared module global makes this test fail (23/24
   chains read the wrong room), then reverts to green — so the tripwire genuinely
   catches the regression, it is not vacuously passing.
2. **Server-level interleave.** One server multiplexes two sessions (distinct rooms
   + budgets) across hundreds of interleaved `tools/call` requests; every in-room
   read is allowed, every cross-room read denied, and each session's final budget
   reflects ONLY its own loads.

## Verified agent config formats (NOT recalled from memory)

The seven agents' MCP config shapes drift, so each was verified at build time and
is pinned by a per-agent snapshot test in `src/install.test.ts`.

| Agent | Tier | Format | Default path | Source of truth | Confidence |
|-------|------|--------|--------------|-----------------|------------|
| Claude Code | 1 | JSON `mcpServers{command,args,env}` | `~/.claude.json` / `.mcp.json` | `claude mcp add-json --help` (live CLI) | High |
| Cursor | 1 | JSON `mcpServers{command,args,env}` | `~/.cursor/mcp.json` | cursor.com/docs/mcp (web) | High |
| OpenCode | 1 | JSON `mcp{type:"local",command:[…],enabled,environment}` | `~/.config/opencode/opencode.json` | opencode.ai/docs/mcp-servers (web, verbatim) | High |
| Codex CLI | 1 | TOML `[mcp_servers.<name>] command,args,env` | `~/.codex/config.toml` | developers.openai.com/codex/config-reference (web) | High |
| Gemini CLI | 1 | JSON `mcpServers{command,args,env}` | `~/.gemini/settings.json` | live `~/.gemini/settings.json` on this machine | High |
| Goose | 1 | YAML `extensions.<name>{type:stdio,cmd,args,envs,timeout}` | `~/.config/goose/config.yaml` | live `~/.config/goose/config.yaml` (a `type: stdio` block) | High |
| Pi | 2 | in-process import (TS extension re-export) | `~/.pi/agent/extensions/skill-accessor.ts` | live `~/.pi/agent/extensions/skill-accessor.ts` (`ExtensionAPI`, `registerTool`) | High |

### Residual uncertainties (flagged honestly, not guessed)

- **Claude Code scope.** The user-scope file `~/.claude.json` is large and
  project-structured; the most robust install path is `claude mcp add-json harbor
  '<json>'` (emitted in the instructions) or a project `.mcp.json`. The emitted
  `mcpServers{…}` block is correct for both; `--write` to `~/.claude.json` does a
  shallow `mcpServers` merge that may not match Claude's per-project nesting — the
  instructions steer users to the CLI/`.mcp.json` instead.
- **Goose YAML `--write`.** Harbor ships no YAML writer, so `applyConfig` for goose
  is a **targeted, idempotent text insertion** (insert the harbor block under an
  existing `extensions:` line, or append an `extensions:` section), not a structured
  re-serialization. JSON (claude/cursor/gemini/opencode) and TOML (codex) use real
  structured merges. The goose path is covered by tests for both the existing-block
  and no-block cases, but a hand-edited/exotic goose YAML could place `extensions:`
  where the regex insert is suboptimal — emission (no `--write`) is always the safe
  default and prints the exact block to paste.
- **Env var expansion.** Emitted configs reference `${AGENT_ENV_ROOM}` /
  `${AGENT_ENV_SESSION}`. Not every MCP client expands `${VAR}` in `env` values; in
  Harbor-spawned sessions these are injected into the process environment by
  `spawn()` and the server reads them directly. For a manually-launched server the
  user sets them in the launching shell. Documented in the emitted instructions.

## Honest enforcement (BUILD_BRIEF §6 — not over-claimed)

Routing skill access through the MCP server (or the Pi import) is a **tool-level
boundary, not OS-level enforcement**. An agent with raw filesystem access can still
read a `SKILL.md` directly. The emitted install instructions say *"routes skill
access through Harbor's room/budget gate … not an OS sandbox"* — never "enforced".
The module headers and the dashboard copy carry the same honest framing.

## Soak safety + de-personalization

- No test reads the real `$HOME`, `~/.agent-env`, or `process.cwd()`. Every test
  threads an explicit `Environment` rooted in a `mkdtemp` dir and an explicit
  `procEnv` / `home`; all I/O lands under the temp root. The
  `no-test-reads-the-live-machine` tripwire stays green.
- Emitted configs are generic: command `harbor`, `${AGENT_ENV_*}` env references,
  the generic example server name `filesystem`/`github` only where examples appear,
  no personal MCP servers, no room names, no absolute user paths. De-perso scan over
  `src/` + `integrations/` is clean (the only `/Users/` / `quickbooks` strings are
  negative `.not.toContain(...)` assertions and rule-documenting comments).

## Determinism

Concurrency-sensitive phase. Verified with repeated full-suite runs including
`--rerun-each` and `bun test --randomize`, plus a 4× concurrent-load burst.
Results recorded in the commit message / gate report.
