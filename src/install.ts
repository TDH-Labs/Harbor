/**
 * install.ts — `harbor install --for <agent>`: emit agent-specific config.
 *
 * EMIT, DON'T MUTATE (BUILD_BRIEF §6). `emitSnippet()` returns the exact config
 * block to add for an agent — the CLI prints it to stdout by default and changes
 * nothing. Only an explicit `--write` (run by the user) calls `applyConfig()`,
 * which backs up the existing config and merges the Harbor entry in. Harbor never
 * silently modifies a running agent's config file.
 *
 * Two tiers (BUILD_BRIEF §6):
 *   - Tier 1 — MCP server: Claude Code, Cursor, OpenCode, Codex, Gemini, Goose.
 *     One stdio entry pointing at `harbor mcp-server`. The room/session come from
 *     `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION` in the launching environment —
 *     but HOW each client gets them there differs per client and is not
 *     interchangeable: see {@link EnvSyntax}, where every dialect is recorded
 *     against a live verification rather than assumed. A client handed a syntax
 *     it does not recognize does not error; it passes the template text through
 *     as the room name, which is why this matters.
 *   - Tier 2 — in-process import: Pi. A one-line extension re-export of
 *     `harbor-tugboat/integrations/pi` — no subprocess.
 *
 * Config formats are VERIFIED AT BUILD TIME against each agent's current spec and
 * live config, not recalled from memory (see PHASE5_NOTES.md for the evidence and
 * the few points of residual uncertainty). The shapes drift, so each is pinned by
 * a per-agent snapshot test.
 *
 * De-personalization (BUILD_BRIEF §3): every emitted snippet is generic. The
 * command is `harbor` (overridable); env values are variable references, or at
 * most the environment's own configured default room, never a hand-picked room
 * name or a personal path; no
 * personal MCP servers appear. Default config paths resolve from an explicit
 * `home` (tests) or `$HOME` — never a hardcoded absolute user path.
 *
 * Honest enforcement: adding this server routes an agent's skill access through
 * Harbor's gate, but it is not an OS sandbox — an agent with raw filesystem
 * access can still read a SKILL.md directly. The emitted comments say "routes
 * skill access through Harbor", never "enforced".
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

// ── Agents + formats ─────────────────────────────────────────────────────────

export type AgentId =
  | "claude-code"
  | "cursor"
  | "opencode"
  | "codex"
  | "gemini"
  | "goose"
  | "pi"
  | "orchestrator";

export const AGENT_IDS: readonly AgentId[] = [
  "claude-code",
  "cursor",
  "opencode",
  "codex",
  "gemini",
  "goose",
  "pi",
  "orchestrator",
];

/** Wire format of an agent's config — drives both emission and `--write` merge. */
export type ConfigFormat = "json-mcpServers" | "json-mcp" | "toml" | "yaml" | "typescript" | "yaml-orchestrator";

export interface EmitOptions {
  /** Server command (default "harbor"). */
  command?: string;
  /** Server args (default ["mcp-server"]). */
  args?: string[];
  /** Server / extension key name (default "harbor"). */
  serverName?: string;
  /** Home dir for resolving default config paths (default `$HOME` then os.homedir). */
  home?: string;
  /** Process env (used to resolve `home` when not given). */
  procEnv?: Record<string, string | undefined>;
  /**
   * Configured room names ("orchestrator" agent only). That target gets one
   * Harbor MCP connection PER ROOM, each with a fixed `AGENT_ENV_ROOM` —
   * unlike every other agent here, which gets one generic connection whose
   * room comes from the launching process's own env. This is deliberate: a
   * delegating orchestrator needs distinctly-scoped connections to delegate
   * into, not one connection scoped to whatever room happens to launch it.
   */
  rooms?: string[];
  /**
   * The room baked into the emitted config. How it is used depends on the
   * agent's {@link EnvSyntax}: clients that interpolate live take it only as
   * the `${VAR:-default}` fallback (so `AGENT_ENV_ROOM` from the launching
   * shell still wins); a client that cannot substitute at all takes it as the
   * literal value; clients that only ever read the live variable ignore it.
   * Defaults to "general" — callers pass the environment's configured default
   * room (the CLI does).
   */
  room?: string;
}

export interface InstallSnippet {
  agent: AgentId;
  /** 1 = MCP server, 2 = in-process import. */
  tier: 1 | 2;
  format: ConfigFormat;
  /** Suggested config file (home-resolved). Informational unless `--write`. */
  defaultPath: string;
  /** The config text to add. */
  snippet: string;
  /** Human guidance: CLI alternative, manual steps, the honest-enforcement note. */
  instructions: string;
}

/**
 * How an agent's config expresses the `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION`
 * values. MCP clients differ sharply and none of them errors on a syntax it
 * doesn't recognize — it just hands the literal template text to the server as
 * the room name. Each variant below was VERIFIED (2026-07-23), not assumed:
 * an env-probe shim stood in for the server and recorded exactly what arrived.
 *
 *  - `shell`    — `${VAR}` expands, and `${VAR:-default}` is supported, so the
 *                 launching environment wins and a bare launch still lands on a
 *                 real room. Verified live: Claude Code, Gemini CLI.
 *  - `vscode`   — VS Code-style `${env:VAR}`; `${VAR}` is NOT expanded. No
 *                 default syntax exists, so an unset variable arrives blank or
 *                 literal — both normalize to the default room server-side
 *                 (see normalizeRoomEnv). Cursor, per its published docs.
 *  - `opencode` — OpenCode's own `{env:VAR}`; `${VAR}` is ignored entirely
 *                 (verified: the literal `${AGENT_ENV_ROOM}` reached the
 *                 server even with the variable set in the launching shell).
 *  - `codex`    — no substitution anywhere, AND the child environment is
 *                 scrubbed (`env_clear()` + an allowlist), so nothing is
 *                 inherited either. Its `env_vars` key is the sanctioned
 *                 passthrough: named variables are forwarded live, and simply
 *                 omitted when unset — which lands on the default room.
 *  - `literal`  — no substitution of any kind, so the room is baked in at
 *                 install time. Verified: Goose.
 */
type EnvSyntax = "shell" | "vscode" | "opencode" | "codex" | "literal";

interface AgentSpec {
  tier: 1 | 2;
  format: ConfigFormat;
  /** Default config path relative to home (POSIX segments). */
  pathFromHome: string[];
  /** Verified env-substitution syntax for this client (see {@link EnvSyntax}). */
  envSyntax: EnvSyntax;
  /** Extra instruction lines (e.g. a native CLI command). */
  extraInstructions?: (ctx: { command: string; args: string[]; serverName: string }) => string[];
}

const AGENTS: Record<AgentId, AgentSpec> = {
  "claude-code": {
    tier: 1,
    format: "json-mcpServers",
    pathFromHome: [".claude.json"],
    envSyntax: "shell",
    extraInstructions: ({ serverName }) => [
      `Project scope: add the block to ./.mcp.json (top-level "mcpServers").`,
      `Or use the CLI: claude mcp add-json ${serverName} '<the JSON object above>'`,
      `Verify with: claude mcp list`,
    ],
  },
  cursor: {
    tier: 1,
    format: "json-mcpServers",
    pathFromHome: [".cursor", "mcp.json"],
    envSyntax: "vscode",
    extraInstructions: () => [
      `Project scope: ./.cursor/mcp.json (same shape).`,
      `Cursor interpolates \${env:VAR}, not \${VAR}, and does not pass the parent`,
      `environment through to MCP servers — the room must be named explicitly here.`,
    ],
  },
  opencode: {
    tier: 1,
    format: "json-mcp",
    pathFromHome: [".config", "opencode", "opencode.json"],
    envSyntax: "opencode",
    extraInstructions: () => [
      `OpenCode uses the "mcp" key with type "local" and an array command.`,
      `Its interpolation syntax is {env:VAR} — \${VAR} is NOT expanded and would`,
      `reach the server as literal text.`,
    ],
  },
  codex: {
    tier: 1,
    format: "toml",
    pathFromHome: [".codex", "config.toml"],
    envSyntax: "codex",
    extraInstructions: () => [
      `Codex reads MCP servers from config.toml under [mcp_servers.<name>].`,
      `Codex spawns MCP servers with a SCRUBBED environment and expands nothing,`,
      `so the room is forwarded via env_vars (its sanctioned passthrough) rather`,
      `than an env table. Unset simply omits the key, which falls back to the`,
      `environment's configured default room.`,
    ],
  },
  gemini: {
    tier: 1,
    format: "json-mcpServers",
    pathFromHome: [".gemini", "settings.json"],
    envSyntax: "shell",
  },
  goose: {
    tier: 1,
    format: "yaml",
    pathFromHome: [".config", "goose", "config.yaml"],
    envSyntax: "literal",
    extraInstructions: () => [
      `Goose registers MCP servers as stdio extensions under "extensions".`,
      `Goose does NOT expand \${VAR} in extensions.<name>.envs — the room/session`,
      `above are literal, pinned at install time (pass --room to pick one; a bare`,
      `re-run without it defaults to "general"). To use a DIFFERENT room for one`,
      `interactive session without editing this file, launch goose with its own`,
      `--with-extension flag instead of relying on this static entry, e.g.:`,
      `  goose session --with-extension "AGENT_ENV_ROOM=<room> AGENT_ENV_SESSION=<id> harbor mcp-server"`,
    ],
  },
  pi: {
    tier: 2,
    format: "typescript",
    pathFromHome: [".pi", "agent", "extensions", "skill-accessor.ts"],
    // Tier 2 runs IN-PROCESS and reads the real process env directly, so there
    // is no config file to substitute into and nothing to get wrong here.
    envSyntax: "literal",
    extraInstructions: () => [
      `Tier 2 (in-process import): no subprocess, <3ms per call.`,
      `Run Pi with --no-skills so Harbor owns skill loading.`,
    ],
  },
  // A generic target for any delegating-orchestrator style harness (spawns
  // sub-agents with a curated toolset), not one specific product — the
  // pattern below applies broadly, so it isn't pinned to a single agent's
  // config schema. Point --path at whatever your harness actually reads.
  orchestrator: {
    tier: 1,
    format: "yaml-orchestrator",
    pathFromHome: [".config", "orchestrator-agent", "mcp.yaml"],
    // Emits one connection per room, each already pinned to a literal room.
    envSyntax: "literal",
    extraInstructions: ({ serverName }) => [
      `Placeholder path — pass --path to point at your orchestrator's real`,
      `MCP config file.`,
      `One connection per configured room (${serverName}_<room>), not one shared`,
      `connection — an orchestrator needs distinctly-scoped access to delegate`,
      `into, not a single room. list_rooms works identically through any of them.`,
      `Two more steps most delegating-orchestrator harnesses need beyond this`,
      `file (many scope a sub-agent's tools by intersecting a requested toolset`,
      `against the PARENT's own available toolsets, so a toolset the top-level`,
      `agent can't see gets silently stripped from any child that asks for`,
      `it — check your harness's own docs for this exact behavior):`,
      `  1. Add every "${serverName}_<room>" name to wherever the top-level`,
      `     agent's own available-toolset list lives, so it has them to hand`,
      `     down (a child is narrowed from what the parent already has — it`,
      `     never gains something the parent lacks).`,
      `  2. Register each "${serverName}_<room>" toolset with your harness's`,
      `     custom-toolset mechanism, bundling that room's`,
      `     "${serverName}_<room>__*" tool names. If your harness is`,
      `     third-party, do this as a local hook — never an edit to its`,
      `     tracked source.`,
      `Then: delegating a sub-agent scoped to "${serverName}_<room>" reaches`,
      `only that room's Harbor-gated tools.`,
    ],
  },
};

// ── Emission ─────────────────────────────────────────────────────────────────

function resolveHome(options: EmitOptions): string {
  if (options.home) return options.home;
  const env = options.procEnv ?? process.env;
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

/**
 * The Harbor server's env block, in the calling agent's OWN verified
 * substitution syntax (see {@link EnvSyntax}).
 *
 * Every value stays generic — a `${VAR}` reference, or the environment's
 * configured default room, never a personal path or hand-picked room name.
 * `codex` returns an empty block on purpose: it forwards the variables through
 * its `env_vars` allowlist instead (rendered by the TOML branch).
 */
function serverEnv(syntax: EnvSyntax, room: string): Record<string, string> {
  switch (syntax) {
    case "shell":
      // Launching env wins; a bare launch still lands on a real room.
      return {
        AGENT_ENV_ROOM: `\${AGENT_ENV_ROOM:-${room}}`,
        AGENT_ENV_SESSION: `\${AGENT_ENV_SESSION:-harbor-${room}}`,
      };
    case "vscode":
      return {
        AGENT_ENV_ROOM: "${env:AGENT_ENV_ROOM}",
        AGENT_ENV_SESSION: "${env:AGENT_ENV_SESSION}",
      };
    case "opencode":
      return {
        AGENT_ENV_ROOM: "{env:AGENT_ENV_ROOM}",
        AGENT_ENV_SESSION: "{env:AGENT_ENV_SESSION}",
      };
    case "codex":
      return {};
    case "literal":
      return { AGENT_ENV_ROOM: room, AGENT_ENV_SESSION: `harbor-${room}` };
  }
}

/** Variables Codex forwards live from the launching shell via its allowlist. */
const CODEX_ENV_VARS = ["AGENT_ENV_ROOM", "AGENT_ENV_SESSION"];

const ENFORCEMENT_NOTE =
  "Note: this routes skill access through Harbor's room/budget gate. It is a tool-" +
  "level boundary, not an OS sandbox — an agent with raw filesystem access can still " +
  "read skill files directly.";

/** Build the config snippet + guidance for one agent. */
export function emitSnippet(agent: AgentId, options: EmitOptions = {}): InstallSnippet {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`unknown agent: ${agent}`);
  const command = options.command ?? "harbor";
  const args = options.args ?? ["mcp-server"];
  const serverName = options.serverName ?? "harbor";
  const home = resolveHome(options);
  const defaultPath = join(home, ...spec.pathFromHome);

  const rooms = options.rooms ?? [];
  const room = options.room ?? "general";
  const snippet = renderSnippet(spec.format, {
    command, args, serverName, rooms, room, envSyntax: spec.envSyntax,
  });
  const lines: string[] = [`Add to ${defaultPath}:`];
  if (spec.extraInstructions) lines.push(...spec.extraInstructions({ command, args, serverName }));
  lines.push(ENFORCEMENT_NOTE);

  return { agent, tier: spec.tier, format: spec.format, defaultPath, snippet, instructions: lines.join("\n") };
}

/** Render just the config block for a format (the unit each snapshot test pins). */
export function renderSnippet(
  format: ConfigFormat,
  ctx: {
    command: string;
    args: string[];
    serverName: string;
    rooms?: string[];
    room?: string;
    /** The agent's verified substitution syntax; two agents can share a format
     *  but differ here (claude-code and cursor are both json-mcpServers). */
    envSyntax?: EnvSyntax;
  },
): string {
  const { command, args, serverName, rooms = [], room = "general", envSyntax = "shell" } = ctx;
  const env = serverEnv(envSyntax, room);
  switch (format) {
    case "json-mcpServers":
      return JSON.stringify({ mcpServers: { [serverName]: { command, args, env } } }, null, 2);
    case "json-mcp":
      return JSON.stringify(
        {
          mcp: {
            [serverName]: {
              type: "local",
              command: [command, ...args],
              enabled: true,
              environment: env,
            },
          },
        },
        null,
        2,
      );
    case "toml":
      // Codex expands nothing and scrubs the child environment; `env_vars` is
      // its sanctioned live passthrough, so it replaces the env table entirely.
      return stringifyToml({
        mcp_servers: {
          [serverName]:
            envSyntax === "codex"
              ? { command, args, env_vars: CODEX_ENV_VARS }
              : { command, args, env },
        },
      });
    case "yaml":
      return renderGooseExtension(serverName, command, args, 0, room);
    case "typescript":
      return [
        "/**",
        " * Harbor skill-accessor — Tier 2 in-process integration.",
        " * Replaces bulk skill loading with Harbor's room-gated, budgeted read_skill.",
        " */",
        'export { default } from "harbor-tugboat/integrations/pi";',
        "",
      ].join("\n");
    case "yaml-orchestrator":
      return renderOrchestratorMcpServers(serverName, command, args, rooms, 0);
    default:
      throw new Error(`unknown format: ${format}`);
  }
}

/**
 * Render `mcp_servers: {<serverName>_<room>: {...}}` — one entry per room, each
 * with a LITERAL `AGENT_ENV_ROOM` (not the `${AGENT_ENV_ROOM}` placeholder every
 * other agent gets here) since each connection must stay pinned to its own room
 * regardless of whatever room happens to launch the parent orchestrator process.
 * A delegating-orchestrator harness's config generally carries no YAML writer
 * either (same reason goose's renderer is hand-rolled lines, not a library) —
 * this is deliberately the same style.
 */
function renderOrchestratorMcpServers(
  serverName: string,
  command: string,
  args: string[],
  rooms: string[],
  baseIndent: number,
): string {
  const pad = " ".repeat(baseIndent);
  const i2 = pad + "  ";
  const i4 = pad + "    ";
  const i6 = pad + "      ";
  if (rooms.length === 0) {
    return `${pad}mcp_servers: {} # no rooms configured — nothing to add yet`;
  }
  const lines = [`${pad}mcp_servers:`];
  for (const room of rooms) {
    lines.push(
      `${i2}${serverName}_${room}:`,
      `${i4}command: ${command}`,
      `${i4}args:`,
      ...args.map((a) => `${i6}- ${a}`),
      `${i4}env:`,
      `${i6}AGENT_ENV_ROOM: ${room}`,
      `${i6}AGENT_ENV_SESSION: ${serverName}-${room}`,
    );
  }
  return lines.join("\n");
}

/**
 * Render a goose `extensions.<name>` stdio block at the given base indent.
 *
 * `room` is a LITERAL value (not the `${AGENT_ENV_ROOM}` placeholder every
 * other Tier 1 agent gets here) — confirmed empirically that Goose passes
 * `extensions.<name>.envs` values to the child process as-is, with no `${VAR}`
 * expansion from its own environment. A placeholder there would silently
 * break room resolution. Session id mirrors orchestrator's `<name>-<room>`
 * convention (a deterministic literal, not a runtime-generated one — Goose's
 * static config has no way to mint a fresh id per launch).
 */
function renderGooseExtension(name: string, command: string, args: string[], baseIndent: number, room: string): string {
  const pad = " ".repeat(baseIndent);
  const i2 = pad + "  ";
  const i4 = pad + "    ";
  const i6 = pad + "      ";
  const lines = [
    `${pad}extensions:`,
    `${i2}${name}:`,
    `${i4}enabled: true`,
    `${i4}type: stdio`,
    `${i4}name: ${name}`,
    `${i4}cmd: ${command}`,
    `${i4}args:`,
    ...args.map((a) => `${i6}- ${a}`),
    `${i4}envs:`,
    `${i6}AGENT_ENV_ROOM: ${room}`,
    `${i6}AGENT_ENV_SESSION: ${name}-${room}`,
    `${i4}timeout: 300`,
    `${i4}bundled: null`,
  ];
  return lines.join("\n");
}

// ── --write (user-run, with backup) ──────────────────────────────────────────

export interface ApplyOptions extends EmitOptions {
  /** Target config path (defaults to the agent's home-resolved path). */
  path?: string;
}

export interface ApplyResult {
  path: string;
  /** Backup of the prior file, or null when the file was newly created. */
  backup: string | null;
  /** "created" (no prior file), "merged" (entry added/updated), "unchanged" (already present). */
  action: "created" | "merged" | "unchanged";
}

/**
 * Apply the Harbor entry to an agent's config file. Backs up any existing file
 * first, then merges structurally (JSON/TOML), inserts (goose YAML), or writes
 * the dedicated extension file (Pi). Idempotent: re-applying does not duplicate.
 * NEVER call this without an explicit user `--write`.
 */
export function applyConfig(agent: AgentId, options: ApplyOptions = {}): ApplyResult {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`unknown agent: ${agent}`);
  const command = options.command ?? "harbor";
  const args = options.args ?? ["mcp-server"];
  const serverName = options.serverName ?? "harbor";
  const home = resolveHome(options);
  const path = options.path ?? join(home, ...spec.pathFromHome);

  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : "";

  const merge = mergeFor(spec.format);
  const result = merge(existing, existed, {
    command,
    args,
    serverName,
    rooms: options.rooms ?? [],
    room: options.room ?? "general",
    envSyntax: spec.envSyntax,
  });
  if (result.action === "unchanged") {
    return { path, backup: null, action: "unchanged" };
  }

  // Back up the prior file before writing (never clobber an existing backup).
  let backup: string | null = null;
  if (existed) {
    backup = nextBackupPath(path);
    copyFileSync(path, backup);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.content);
  return { path, backup, action: existed ? "merged" : "created" };
}

interface MergeOutcome {
  content: string;
  action: "merged" | "created" | "unchanged";
}
type MergeFn = (
  existing: string,
  existed: boolean,
  ctx: {
    command: string;
    args: string[];
    serverName: string;
    rooms?: string[];
    room?: string;
    envSyntax?: EnvSyntax;
  },
) => MergeOutcome;

function mergeFor(format: ConfigFormat): MergeFn {
  switch (format) {
    case "json-mcpServers":
      return (existing, existed, ctx) =>
        mergeJson(existing, existed, "mcpServers", ctx.serverName, {
          command: ctx.command,
          args: ctx.args,
          env: serverEnv(ctx.envSyntax ?? "shell", ctx.room ?? "general"),
        });
    case "json-mcp":
      return (existing, existed, ctx) =>
        mergeJson(existing, existed, "mcp", ctx.serverName, {
          type: "local",
          command: [ctx.command, ...ctx.args],
          enabled: true,
          environment: serverEnv(ctx.envSyntax ?? "shell", ctx.room ?? "general"),
        });
    case "toml":
      return (existing, existed, ctx) => mergeToml(existing, existed, ctx);
    case "yaml":
      return (existing, existed, ctx) => mergeGoose(existing, existed, ctx);
    case "yaml-orchestrator":
      return (existing, existed, ctx) => mergeOrchestrator(existing, existed, ctx.serverName, ctx.command, ctx.args, ctx.rooms ?? []);
    case "typescript":
      return (existing, _existed, ctx) => {
        const content = renderSnippet("typescript", ctx) ;
        return { content, action: existing === content ? "unchanged" : (existing ? "merged" : "created") };
      };
    default:
      throw new Error(`unknown format: ${format}`);
  }
}

function mergeJson(
  existing: string,
  existed: boolean,
  topKey: string,
  serverName: string,
  entry: Record<string, unknown>,
): MergeOutcome {
  let doc: Record<string, unknown> = {};
  if (existed && existing.trim()) {
    const parsed = JSON.parse(existing) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  }
  const section = (doc[topKey] && typeof doc[topKey] === "object" ? doc[topKey] : {}) as Record<string, unknown>;
  if (JSON.stringify(section[serverName]) === JSON.stringify(entry)) {
    return { content: existing, action: "unchanged" };
  }
  section[serverName] = entry;
  doc[topKey] = section;
  return { content: JSON.stringify(doc, null, 2) + "\n", action: existed ? "merged" : "created" };
}

function mergeToml(
  existing: string,
  existed: boolean,
  ctx: { command: string; args: string[]; serverName: string; room?: string; envSyntax?: EnvSyntax },
): MergeOutcome {
  let doc: Record<string, unknown> = {};
  if (existed && existing.trim()) {
    doc = parseToml(existing) as Record<string, unknown>;
  }
  const servers = (doc.mcp_servers && typeof doc.mcp_servers === "object"
    ? doc.mcp_servers
    : {}) as Record<string, unknown>;
  const syntax = ctx.envSyntax ?? "shell";
  // Codex scrubs the child environment and expands nothing — `env_vars` is its
  // sanctioned live passthrough and replaces the env table (see EnvSyntax).
  const entry =
    syntax === "codex"
      ? { command: ctx.command, args: ctx.args, env_vars: CODEX_ENV_VARS }
      : { command: ctx.command, args: ctx.args, env: serverEnv(syntax, ctx.room ?? "general") };
  if (JSON.stringify(servers[ctx.serverName]) === JSON.stringify(entry)) {
    return { content: existing, action: "unchanged" };
  }
  servers[ctx.serverName] = entry;
  doc.mcp_servers = servers;
  return { content: stringifyToml(doc) + "\n", action: existed ? "merged" : "created" };
}

/**
 * Insert (or upsert) a goose stdio extension. Goose config is YAML and Harbor
 * carries no YAML writer, so this is targeted text insertion (the one format
 * without a structured merge — flagged in PHASE5_NOTES). If `extensions:`
 * exists, the harbor block is inserted under it; otherwise an `extensions:`
 * section is added.
 *
 * Upsert, not just presence-check: an existing `<name>:` entry whose body
 * differs from what would be emitted now (e.g. an outdated hardcoded room, or
 * a missing AGENT_ENV_SESSION from before this field existed) is REPLACED in
 * place, matching config-edit.ts's addMcpServerToRoom precedent — otherwise
 * re-running `--write` after fixing a stale entry would silently no-op and
 * leave the bug in place.
 */
function mergeGoose(
  existing: string,
  existed: boolean,
  ctx: { command: string; args: string[]; serverName: string; room?: string },
): MergeOutcome {
  const room = ctx.room ?? "general";

  if (!existed || !existing.trim()) {
    return {
      content: renderGooseExtension(ctx.serverName, ctx.command, ctx.args, 0, room) + "\n",
      action: "created",
    };
  }

  const lines = existing.split("\n");
  // Line-equality (not a dynamic RegExp) so a server name with regex
  // metacharacters can't mis-match — and there's no ReDoS surface.
  const startIdx = lines.findIndex((l) => l.trimEnd() === `  ${ctx.serverName}:`);
  const newBody = indentGooseUnderExtensions(ctx.serverName, ctx.command, ctx.args, room);

  if (startIdx >= 0) {
    // Present — find the full span (this line through the last line indented
    // deeper than the `  <name>:` key itself) and upsert only if it differs.
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= 2) {
        endIdx = i;
        break;
      }
    }
    const currentBody = lines.slice(startIdx, endIdx).join("\n");
    if (currentBody === newBody) {
      return { content: existing, action: "unchanged" };
    }
    const merged = [...lines.slice(0, startIdx), ...newBody.split("\n"), ...lines.slice(endIdx)];
    return { content: merged.join("\n"), action: "merged" };
  }

  const idx = lines.findIndex((l) => /^extensions:\s*$/.test(l));
  if (idx >= 0) {
    lines.splice(idx + 1, 0, newBody);
    return { content: lines.join("\n"), action: "merged" };
  }
  // No extensions section — append one.
  const sep = existing.endsWith("\n") ? "" : "\n";
  return {
    content: existing + sep + renderGooseExtension(ctx.serverName, ctx.command, ctx.args, 0, room) + "\n",
    action: "merged",
  };
}

/** The harbor extension entry indented for placement directly under `extensions:`. */
function indentGooseUnderExtensions(name: string, command: string, args: string[], room: string): string {
  // renderGooseExtension emits its own `extensions:` line first; drop it and keep
  // the already-2-space-indented body.
  const full = renderGooseExtension(name, command, args, 0, room).split("\n");
  return full.slice(1).join("\n");
}

/**
 * Insert `<serverName>_<room>` entries for rooms not already present, under
 * the orchestrator's `mcp_servers:` key. Line-based INSERTION only, never a
 * parse→rebuild — a real orchestrator config.yaml can easily carry live
 * secrets in sibling entries (API tokens, connect URLs) with hand-maintained
 * comments a generic YAML round-trip would reformat or drop. Existing rooms
 * are left untouched (in case they were hand-edited); only genuinely missing
 * rooms are added, so re-running after a room config change is safe and
 * idempotent.
 */
function mergeOrchestrator(
  existing: string,
  existed: boolean,
  serverName: string,
  command: string,
  args: string[],
  rooms: string[],
): MergeOutcome {
  if (rooms.length === 0) return { content: existing, action: "unchanged" };

  const lines = existed ? existing.split("\n") : [];
  const missing = rooms.filter((room) => !lines.some((l) => l.trimEnd() === `  ${serverName}_${room}:`));
  if (missing.length === 0) return { content: existing, action: "unchanged" };

  const newBlock = renderOrchestratorMcpServers(serverName, command, args, missing, 0);

  if (!existed || !existing.trim()) {
    return { content: newBlock + "\n", action: "created" };
  }

  const mcpIdx = lines.findIndex((l) => /^mcp_servers:\s*$/.test(l));
  if (mcpIdx >= 0) {
    // Drop the block's own `mcp_servers:` header — inserting directly under the
    // existing one — and splice in right after it, ahead of any existing entries.
    const entryLines = newBlock.split("\n").slice(1);
    lines.splice(mcpIdx + 1, 0, ...entryLines);
    return { content: lines.join("\n"), action: "merged" };
  }
  // No mcp_servers section at all — append one.
  const sep = existing.endsWith("\n") ? "" : "\n";
  return { content: existing + sep + newBlock + "\n", action: "merged" };
}

/** First non-existing of `<path>.bak`, `<path>.bak.1`, ... — never clobbers a backup. */
function nextBackupPath(path: string): string {
  let candidate = `${path}.bak`;
  let n = 1;
  while (existsSync(candidate)) {
    candidate = `${path}.bak.${n++}`;
  }
  return candidate;
}
