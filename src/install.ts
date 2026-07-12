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
 *     `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION` in the launching environment.
 *   - Tier 2 — in-process import: Pi. A one-line extension re-export of
 *     `harbor-tugboat/integrations/pi` — no subprocess.
 *
 * Config formats are VERIFIED AT BUILD TIME against each agent's current spec and
 * live config, not recalled from memory (see PHASE5_NOTES.md for the evidence and
 * the few points of residual uncertainty). The shapes drift, so each is pinned by
 * a per-agent snapshot test.
 *
 * De-personalization (BUILD_BRIEF §3): every emitted snippet is generic. The
 * command is `harbor` (overridable); env values are `${AGENT_ENV_ROOM}` /
 * `${AGENT_ENV_SESSION}` references, never literal room names or paths; no
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

interface AgentSpec {
  tier: 1 | 2;
  format: ConfigFormat;
  /** Default config path relative to home (POSIX segments). */
  pathFromHome: string[];
  /** Extra instruction lines (e.g. a native CLI command). */
  extraInstructions?: (ctx: { command: string; args: string[]; serverName: string }) => string[];
}

const AGENTS: Record<AgentId, AgentSpec> = {
  "claude-code": {
    tier: 1,
    format: "json-mcpServers",
    pathFromHome: [".claude.json"],
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
    extraInstructions: () => [`Project scope: ./.cursor/mcp.json (same shape).`],
  },
  opencode: {
    tier: 1,
    format: "json-mcp",
    pathFromHome: [".config", "opencode", "opencode.json"],
    extraInstructions: () => [`OpenCode uses the "mcp" key with type "local" and an array command.`],
  },
  codex: {
    tier: 1,
    format: "toml",
    pathFromHome: [".codex", "config.toml"],
    extraInstructions: () => [`Codex reads MCP servers from config.toml under [mcp_servers.<name>].`],
  },
  gemini: {
    tier: 1,
    format: "json-mcpServers",
    pathFromHome: [".gemini", "settings.json"],
  },
  goose: {
    tier: 1,
    format: "yaml",
    pathFromHome: [".config", "goose", "config.yaml"],
    extraInstructions: () => [`Goose registers MCP servers as stdio extensions under "extensions".`],
  },
  pi: {
    tier: 2,
    format: "typescript",
    pathFromHome: [".pi", "agent", "extensions", "skill-accessor.ts"],
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

/** The Harbor server's env block — generic `${VAR}` references only. */
function serverEnv(): Record<string, string> {
  return {
    AGENT_ENV_ROOM: "${AGENT_ENV_ROOM}",
    AGENT_ENV_SESSION: "${AGENT_ENV_SESSION}",
  };
}

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
  const snippet = renderSnippet(spec.format, { command, args, serverName, rooms });
  const lines: string[] = [`Add to ${defaultPath}:`];
  if (spec.extraInstructions) lines.push(...spec.extraInstructions({ command, args, serverName }));
  lines.push(ENFORCEMENT_NOTE);

  return { agent, tier: spec.tier, format: spec.format, defaultPath, snippet, instructions: lines.join("\n") };
}

/** Render just the config block for a format (the unit each snapshot test pins). */
export function renderSnippet(
  format: ConfigFormat,
  ctx: { command: string; args: string[]; serverName: string; rooms?: string[] },
): string {
  const { command, args, serverName, rooms = [] } = ctx;
  switch (format) {
    case "json-mcpServers":
      return JSON.stringify(
        { mcpServers: { [serverName]: { command, args, env: serverEnv() } } },
        null,
        2,
      );
    case "json-mcp":
      return JSON.stringify(
        {
          mcp: {
            [serverName]: {
              type: "local",
              command: [command, ...args],
              enabled: true,
              environment: serverEnv(),
            },
          },
        },
        null,
        2,
      );
    case "toml":
      return stringifyToml({ mcp_servers: { [serverName]: { command, args, env: serverEnv() } } });
    case "yaml":
      return renderGooseExtension(serverName, command, args, 0);
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

/** Render a goose `extensions.<name>` stdio block at the given base indent. */
function renderGooseExtension(name: string, command: string, args: string[], baseIndent: number): string {
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
    `${i6}AGENT_ENV_ROOM: \${AGENT_ENV_ROOM}`,
    `${i6}AGENT_ENV_SESSION: \${AGENT_ENV_SESSION}`,
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
  const result = merge(existing, existed, { command, args, serverName, rooms: options.rooms ?? [] });
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
  ctx: { command: string; args: string[]; serverName: string; rooms?: string[] },
) => MergeOutcome;

function mergeFor(format: ConfigFormat): MergeFn {
  switch (format) {
    case "json-mcpServers":
      return (existing, existed, ctx) =>
        mergeJson(existing, existed, "mcpServers", ctx.serverName, {
          command: ctx.command,
          args: ctx.args,
          env: serverEnv(),
        });
    case "json-mcp":
      return (existing, existed, ctx) =>
        mergeJson(existing, existed, "mcp", ctx.serverName, {
          type: "local",
          command: [ctx.command, ...ctx.args],
          enabled: true,
          environment: serverEnv(),
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
  ctx: { command: string; args: string[]; serverName: string },
): MergeOutcome {
  let doc: Record<string, unknown> = {};
  if (existed && existing.trim()) {
    doc = parseToml(existing) as Record<string, unknown>;
  }
  const servers = (doc.mcp_servers && typeof doc.mcp_servers === "object"
    ? doc.mcp_servers
    : {}) as Record<string, unknown>;
  const entry = { command: ctx.command, args: ctx.args, env: serverEnv() };
  if (JSON.stringify(servers[ctx.serverName]) === JSON.stringify(entry)) {
    return { content: existing, action: "unchanged" };
  }
  servers[ctx.serverName] = entry;
  doc.mcp_servers = servers;
  return { content: stringifyToml(doc) + "\n", action: existed ? "merged" : "created" };
}

/**
 * Insert a goose stdio extension. Goose config is YAML and Harbor carries no YAML
 * writer, so this is a targeted, idempotent text insertion (the one format without
 * a structured merge — flagged in PHASE5_NOTES). If `extensions:` exists, the
 * harbor block is inserted under it; otherwise an `extensions:` section is added.
 */
function mergeGoose(
  existing: string,
  existed: boolean,
  ctx: { command: string; args: string[]; serverName: string },
): MergeOutcome {
  // Already installed? (a `<2-space>harbor:` key under extensions). Idempotent.
  // Line-equality (not a dynamic RegExp) so a server name with regex
  // metacharacters can't mis-match — and there's no ReDoS surface.
  const present = existing.split("\n").some((l) => l.trimEnd() === `  ${ctx.serverName}:`);
  if (present) return { content: existing, action: "unchanged" };

  if (!existed || !existing.trim()) {
    return { content: renderGooseExtension(ctx.serverName, ctx.command, ctx.args, 0) + "\n", action: "created" };
  }

  const block = indentGooseUnderExtensions(ctx.serverName, ctx.command, ctx.args);
  const lines = existing.split("\n");
  const idx = lines.findIndex((l) => /^extensions:\s*$/.test(l));
  if (idx >= 0) {
    lines.splice(idx + 1, 0, block);
    return { content: lines.join("\n"), action: "merged" };
  }
  // No extensions section — append one.
  const sep = existing.endsWith("\n") ? "" : "\n";
  return { content: existing + sep + renderGooseExtension(ctx.serverName, ctx.command, ctx.args, 0) + "\n", action: "merged" };
}

/** The harbor extension entry indented for placement directly under `extensions:`. */
function indentGooseUnderExtensions(name: string, command: string, args: string[]): string {
  // renderGooseExtension emits its own `extensions:` line first; drop it and keep
  // the already-2-space-indented body.
  const full = renderGooseExtension(name, command, args, 0).split("\n");
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
