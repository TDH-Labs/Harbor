/**
 * mcp.ts — MCP server validation, per-room config generation, multi-room merge.
 *
 * Three jobs, all config-driven (BUILD_BRIEF §3 — no personal/client MCP servers
 * are shipped; rooms declare their own servers in config.toml):
 *
 *   1. validateServer  — does a server's command resolve, are its env vars set,
 *                        and (optionally) does the process start?
 *   2. generateRoomConfigs — write each room's `.room-mcp.json` in the standard
 *                        `{ "mcpServers": { ... } }` shape any MCP client reads.
 *   3. mergeConfigs    — combine several rooms' servers into one config, prefixing
 *                        names with the room to avoid collisions.
 *
 * Behavioral reference: `mcp_check.py` (validation), `room_mcp.py` (generation),
 * and the merge in `mcp_check.merge_room_mcp_configs`.
 *
 * MCP env vars are read from a server's nested `env` table (what TOML produces
 * from `env.KEY = "..."`) and, for resilience, from any flat `env.KEY` keys. A
 * `$VAR` or `${VAR}` value references an environment variable; a literal value is
 * passed through. Downstream contract (Phase 5): `validateServer`,
 * `generateRoomConfigs`, `mergeConfigs` keep stable signatures.
 */
import { existsSync, accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RawMcpServer } from "./config.ts";
import type { Environment } from "./env.ts";
import { isValidRoomName } from "./config-edit.ts";

// ── Types ──────────────────────────────────────────────────────────────────--

export interface CheckResult {
  /** Check identifier, e.g. `command_exists`, `env.TOKEN`, `connectivity`. */
  check: string;
  ok: boolean;
  detail: string;
}

export interface ServerValidation {
  server: string;
  command: string;
  args: string[];
  checks: CheckResult[];
  /** True when every check passed. */
  ok: boolean;
  /** Structural errors (missing name/command); when present the server is invalid. */
  errors: string[];
}

export interface RoomValidation {
  room: string;
  /** "no_servers" when the room declares none; otherwise "ok"/"error". */
  status: "no_servers" | "ok" | "error";
  servers: ServerValidation[];
}

export interface ValidateOptions {
  /** Run a brief process-start connectivity test (default false — off in tests/CI). */
  connectivity?: boolean;
  /** Connectivity timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Environment to read process env vars from (default `process.env`). */
  procEnv?: Record<string, string | undefined>;
}

/** Standard MCP config document: `{ "mcpServers": { name: { command, args?, env? } } }`. */
export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export interface MergeOptions {
  /**
   * Prefix each server name with its room (`<room>-<name>`) to avoid collisions.
   * Default true. When false, names are kept bare and only collisions get a
   * `<room>-` prefix (mirrors the prototype's `--no-prefix`).
   */
  prefix?: boolean;
  /** Write the merged config to this path (pretty JSON + trailing newline). */
  output?: string;
}

// ── env extraction ─────────────────────────────────────────────────────────--

/**
 * Pull a server's MCP env vars from the nested `env` table and any flat
 * `env.KEY` keys (whichever the TOML parser produced). Flat keys win on conflict
 * since they are the more explicit form.
 */
export function extractEnvVars(server: RawMcpServer): Record<string, string> {
  const out: Record<string, string> = {};
  const nested = (server as Record<string, unknown>).env;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
      out[k] = String(v);
    }
  }
  for (const [k, v] of Object.entries(server)) {
    if (k.startsWith("env.")) out[k.slice("env.".length)] = String(v);
  }
  return out;
}

/** The variable name a `$VAR` / `${VAR}` reference points at, or null for a literal. */
function envRef(value: string): string | null {
  if (value.startsWith("${") && value.endsWith("}")) return value.slice(2, -1);
  if (value.startsWith("$")) return value.slice(1);
  return null;
}

// ── command + env + connectivity checks ────────────────────────────────────--

/** Does `command` resolve — as an absolute/relative executable path or on PATH? */
export function checkCommand(command: string): { ok: boolean; detail: string } {
  if (!command) return { ok: false, detail: "no command" };
  if (command.startsWith("/") || command.startsWith("./") || command.startsWith("../")) {
    try {
      accessSync(command, constants.X_OK);
      return { ok: true, detail: command };
    } catch {
      return { ok: false, detail: `${command} not executable` };
    }
  }
  const resolved = Bun.which(command);
  return resolved ? { ok: true, detail: resolved } : { ok: false, detail: "not found on PATH" };
}

/** Check each env var is set: a `$VAR` ref must resolve; a literal always passes. */
export function checkEnvVars(
  envVars: Record<string, string>,
  procEnv: Record<string, string | undefined> = process.env,
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const [k, v] of Object.entries(envVars)) {
    const ref = envRef(v);
    if (ref) {
      const actual = procEnv[ref];
      results.push(
        actual
          ? { check: `env.${k}`, ok: true, detail: `$${ref} set` }
          : { check: `env.${k}`, ok: false, detail: `$${ref} not set` },
      );
    } else {
      results.push({ check: `env.${k}`, ok: true, detail: "literal value" });
    }
  }
  return results;
}

/**
 * Briefly start the server process to confirm the binary runs. A process that
 * exits (even with an error, e.g. missing auth) or one still alive at the
 * timeout both count as "runnable"; only a spawn failure is a hard fail.
 * Mirrors `mcp_check.test_connect`.
 */
export async function testConnect(
  command: string,
  args: string[],
  envVars: Record<string, string>,
  timeoutMs = 5000,
  procEnv: Record<string, string | undefined> = process.env,
): Promise<{ ok: boolean; detail: string }> {
  const expanded: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars)) {
    const ref = envRef(v);
    expanded[k] = ref ? procEnv[ref] ?? "" : v;
  }
  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...procEnv, ...expanded } as Record<string, string>,
    });
    const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
    const exit = proc.exited.then((code) => code);
    const outcome = await Promise.race([exit, timer]);
    if (outcome === "timeout") {
      proc.kill();
      return { ok: true, detail: "started, still running (killed after timeout)" };
    }
    return { ok: true, detail: `exited ${outcome}` };
  } catch (err) {
    return { ok: false, detail: `process error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── server / room validation ───────────────────────────────────────────────--

/** Structural validation: a server must declare `name` and `command`. */
export function validateServerShape(server: RawMcpServer): string[] {
  const errors: string[] = [];
  if (server == null || typeof server !== "object") {
    return ["server entry must be a table"];
  }
  if (!server.name) errors.push("missing 'name'");
  if (!server.command) errors.push("missing 'command'");
  return errors;
}

/**
 * Validate a single MCP server: structure, command resolution, env vars, and
 * (optionally) a connectivity probe. Connectivity is skipped when the command
 * does not resolve.
 */
export async function validateServer(
  server: RawMcpServer,
  options: ValidateOptions = {},
): Promise<ServerValidation> {
  const procEnv = options.procEnv ?? process.env;
  const name = server?.name ?? "unnamed";
  const command = server?.command ?? "";
  const args = server?.args ?? [];
  const errors = validateServerShape(server);

  const checks: CheckResult[] = [];
  const cmd = checkCommand(command);
  checks.push({ check: "command_exists", ok: cmd.ok, detail: cmd.detail });

  const envVars = extractEnvVars(server);
  checks.push(...checkEnvVars(envVars, procEnv));

  if (options.connectivity) {
    if (cmd.ok) {
      const conn = await testConnect(command, args, envVars, options.timeoutMs ?? 5000, procEnv);
      checks.push({ check: "connectivity", ok: conn.ok, detail: conn.detail });
    } else {
      checks.push({ check: "connectivity", ok: false, detail: "skipped (command not found)" });
    }
  }

  const ok = errors.length === 0 && checks.every((c) => c.ok);
  return { server: name, command, args, checks, ok, errors };
}

/** Validate every MCP server declared by a room. */
export async function validateRoom(
  env: Environment,
  room: string,
  options: ValidateOptions = {},
): Promise<RoomValidation> {
  const roomData = env.config.roomSkills[room];
  const servers = roomData?.mcp?.servers ?? [];
  if (servers.length === 0) {
    return { room, status: "no_servers", servers: [] };
  }
  const validated = await Promise.all(servers.map((s) => validateServer(s, options)));
  const status = validated.every((v) => v.ok) ? "ok" : "error";
  return { room, status, servers: validated };
}

/** Validate MCP servers across all configured rooms. */
export async function validateAllRooms(
  env: Environment,
  options: ValidateOptions = {},
): Promise<RoomValidation[]> {
  const out: RoomValidation[] = [];
  for (const room of Object.keys(env.config.roomSkills)) {
    out.push(await validateRoom(env, room, options));
  }
  return out;
}

// ── per-room config generation ─────────────────────────────────────────────--

/** Build the standard MCP config document for a room's server list. */
export function roomMcpConfig(servers: RawMcpServer[]): McpConfig {
  const config: McpConfig = { mcpServers: {} };
  for (const server of servers) {
    const name = server.name || "unnamed";
    config.mcpServers[name] = buildEntry(server);
  }
  return config;
}

function buildEntry(server: RawMcpServer): McpServerEntry {
  const entry: McpServerEntry = { command: server.command ?? "" };
  if (server.args && server.args.length > 0) entry.args = [...server.args];
  const envVars = extractEnvVars(server);
  if (Object.keys(envVars).length > 0) entry.env = envVars;
  return entry;
}

/**
 * Write `rooms/<room>/.room-mcp.json` for a single room, or return null when the
 * room declares no MCP servers (or `room` isn't a valid slug — see
 * {@link isValidRoomName}; harmless in practice today since an invalid name can
 * never be a `config.roomSkills` key, but guarded explicitly rather than left
 * to that incidental protection — the same room-name/path-join pattern is
 * validated at every other write site in this codebase). Mirrors
 * `room_mcp.generate_room_mcp_servers`.
 */
export function generateRoomConfig(env: Environment, room: string): string | null {
  if (!isValidRoomName(room)) return null;
  const servers = env.config.roomSkills[room]?.mcp?.servers ?? [];
  if (servers.length === 0) return null;
  const config = roomMcpConfig(servers);
  const roomDir = join(env.rooms, room);
  mkdirSync(roomDir, { recursive: true });
  const path = join(roomDir, ".room-mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

/**
 * Generate `.room-mcp.json` for every configured room. Returns room → written
 * path (or null when the room has no servers). Mirrors `room_mcp.generate_all`.
 */
export function generateRoomConfigs(env: Environment): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const room of Object.keys(env.config.roomSkills)) {
    out[room] = generateRoomConfig(env, room);
  }
  return out;
}

/** Rooms that declare at least one MCP server. */
export function roomsWithMcp(env: Environment): string[] {
  return Object.keys(env.config.roomSkills).filter(
    (r) => (env.config.roomSkills[r]?.mcp?.servers ?? []).length > 0,
  );
}

// ── merge ──────────────────────────────────────────────────────────────────--

/**
 * Merge several rooms' MCP servers into one config document. With `prefix` (the
 * default) every name becomes `<room>-<name>`; without it, names are kept bare
 * and only a collision is disambiguated with a `<room>-` prefix. Unknown rooms
 * are skipped. Optionally writes the result to `options.output`.
 */
export function mergeConfigs(
  env: Environment,
  rooms: string[],
  options: MergeOptions = {},
): McpConfig {
  const prefix = options.prefix ?? true;
  const merged: McpConfig = { mcpServers: {} };

  for (const room of rooms) {
    const roomData = env.config.roomSkills[room];
    if (!roomData) continue; // unknown room — skip (caller may warn)
    const servers = roomData.mcp?.servers ?? [];
    for (const server of servers) {
      const base = server.name || "unnamed";
      let key: string;
      if (prefix) {
        key = `${room}-${base}`;
      } else {
        key = base in merged.mcpServers ? `${room}-${base}` : base;
      }
      merged.mcpServers[key] = buildEntry(server);
    }
  }

  if (options.output) {
    writeFileSync(options.output, JSON.stringify(merged, null, 2) + "\n");
  }
  return merged;
}
