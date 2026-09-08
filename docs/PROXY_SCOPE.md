# Scope: proxy filesystem / memory / notebooklm / webflow / prompts_chat through Harbor

Goal: a room's harness config becomes just `harbor mcp-server --room=<room>` (already
the pattern `docs/BUZZ.md` documents for channel-scoped rooms), with Harbor brokering
these five external servers instead of each harness spawning its own raw copy.

## Why this isn't a config flip today

Checked `integrations/` — Harbor currently only implements the *server* side of MCP
(`McpServer` / `runStdioServer`, stdio-in). It has no MCP *client* code, so it has no
way to reach filesystem/memory/notebooklm/webflow/prompts_chat on a room's behalf.
Dropping them from Goose's config today just removes the capability.

## What's needed

1. **MCP client capability in Harbor.** New code to speak MCP-client to each of the
   five upstream servers over stdio, using their existing launch commands (currently
   sitting in Goose's `config.yaml`: `npx @modelcontextprotocol/server-filesystem`,
   `npx @modelcontextprotocol/server-memory`, `npx notebooklm-mcp@latest`,
   `webflow-mcp-server`, `npx @fkadev/prompts.chat-mcp@latest`).

2. **A shared hub, not one more copy per room.** If each `harbor mcp-server --room=X`
   spawned its own filesystem/memory/etc., we'd just move the duplication down one
   level. Instead: one long-lived "harbor hub" background daemon (same `PidFile` /
   `startDaemon` pattern already in `watch.ts`) owns the five upstream connections
   *once*, persistently. Each per-room `mcp-server` process (still spawned per-session
   by the harness, still covered by the singleton fix just shipped) becomes a thin
   stdio↔hub proxy — forward `list_tools`/`call_tool`, don't hold the upstream
   connections itself.

3. **Tool namespacing.** The hub's aggregated tool list needs prefixing
   (`filesystem.read_file`, `memory.create_entity`, ...) to avoid collisions, and a
   routing table from prefix → upstream client.

4. **Room-scoped ACLs.** Extend the existing room config (`skills.rooms.<name>` in
   `config.toml`) with which of these five servers (or specific tools) a room may
   reach — same shape as the current skill-gating in `gate.ts`/`audit.ts`, just
   applied to these five instead of skills.

5. **Secrets, held once.** `webflow` needs `WEBFLOW_TOKEN`. Today every harness config
   carries it. With a hub, the token lives in one place and gets injected once.

6. **Rollout.** This changes the runtime shape (adds a persistent daemon) — ship
   behind a flag, keep the raw per-harness configs as fallback until the hub's proven
   stable in practice, then trim Goose/oh-my-pi/Buzz configs down to just `harbor
   mcp-server --room=X`.

## Sizing

This is a real feature — new client-side MCP code, a daemon, ACL schema, secret
handling, namespacing, tests — not a patch. Worth a design pass (especially the hub's
IPC transport and the ACL schema) before writing it, given it changes where tokens
live and introduces a new always-on process.
