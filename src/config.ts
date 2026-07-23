/**
 * config.ts — Machine settings loader for Harbor.
 *
 * Loads TOML (default `~/.agent-env/config.toml`, or an explicit path) and
 * merges it over the built-in {@link DEFAULTS}. A machine with no config.toml
 * behaves exactly as the defaults describe, so the package is runnable by a
 * stranger with zero edits (BUILD_BRIEF §3).
 *
 * Parsing uses `smol-toml` (BUILD_BRIEF §5 resolved decision). The raw merged
 * mapping keeps the TOML's snake_case keys and is exposed as `.data`; typed
 * camelCase getters read from it.
 *
 * De-personalization note: the Python prototype hardcoded capability sets and
 * per-room token budgets keyed by a fixed set of machine-specific room names.
 * Those are gone. Room capabilities and budgets are config-driven here, with
 * neutral generic defaults; no personal room name is shipped.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";

/** Schema version stamped into the environment. */
export const SCHEMA_VERSION = "1.0";

/** Default config location: `~/.agent-env/config.toml`. */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".agent-env", "config.toml");

// ── Typed shape of the raw (snake_case) merged config ────────────────────────

export interface RawMcpServer {
  name: string;
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

export interface RawRoom {
  description?: string;
  /** Skills assigned to this room (room-gating allowlist). */
  skills: string[];
  /**
   * Capabilities granted to sessions in this room. Optional; when absent the
   * room receives {@link DEFAULT_CAPABILITIES}. (New in the TS v1 — replaces the
   * Python prototype's hardcoded ROOM_CAPABILITIES.)
   */
  capabilities?: string[];
  mcp?: { servers: RawMcpServer[] };
  /** Optional per-room session token budget. */
  budget?: number;
}

export interface RawConfig {
  schema_version: string;
  paths: { home: string; skills_dir: string; state_dir: string };
  discovery: {
    scan_home: boolean;
    skip_dirs: string[];
    project_signatures: string[];
    skip_list: string[];
  };
  beacons: { home_targets: string[]; project_beacon: string };
  watch: { paths: string[]; cooldown_seconds: number };
  tidy: {
    enabled: boolean;
    downloads_archive_days: number;
    home_whitelist: string[];
    stray_files: Record<string, string>;
  };
  skill_pool: { sources: Array<{ source: string; into: string }> };
  interview: {
    industry: string;
    industry_label: string;
    organization_mode: string;
    knowledge_layer: boolean;
    data_layer: boolean;
    maintenance_loop: boolean;
  };
  skills: {
    rooms: Record<string, RawRoom>;
    skill_category_to_room: Record<string, string>;
    /** Optional per-skill sub-domain hint (e.g. "litigation"), used to group a
     *  room's skills_index.md into sub-sections. Bare label or "room/label". */
    skill_subdomain: Record<string, string>;
    default_room: string;
  };
  budgets: {
    /** Default per-session token limit (Python prototype DEFAULT_BUDGET). */
    default_session_limit: number;
    /** Default per-room daily token limit for the scheduler. */
    default_room_daily_limit: number;
    /** Per-room session budget overrides. */
    rooms: Record<string, number>;
  };
}

// ── Built-in defaults ────────────────────────────────────────────────────────
// A missing config.toml resolves to exactly these values. Path templates use
// "~" to mean "relative to the environment root" (see env.ts); "~" alone is the
// root. Only universal infrastructure names appear here — no personal project,
// room, data, or app-install names (BUILD_BRIEF §3).

export const DEFAULTS: RawConfig = {
  schema_version: SCHEMA_VERSION,
  paths: {
    home: "~",
    skills_dir: "~/.agents/skills",
    state_dir: "~/.agent-env",
  },
  discovery: {
    scan_home: true,
    skip_dirs: [
      "rooms", "workspace", "archive", "secrets", "scripts",
      ".agents", ".antigravity", ".cursor", ".vscode",
      ".ssh", ".gnupg", ".config", ".cache", ".local", ".npm",
      ".docker", ".cargo", ".rustup", ".pyenv", ".asdf",
      "node_modules", ".venv", "venv", "__pycache__",
      "Applications", "Desktop", "Documents", "Downloads", "Library",
      "Movies", "Music", "Pictures", "Public",
      ".DS_Store", ".Trash", ".TemporaryItems",
    ],
    project_signatures: [
      ".git", "AGENTS.md", "CLAUDE.md", "package.json", "Cargo.toml",
      "pyproject.toml", "go.mod", "Gemfile", "Makefile", "justfile",
      "PROJECT.md",
    ],
    skip_list: [],
  },
  beacons: {
    home_targets: ["AGENTS.md", "CLAUDE.md", ".cursorrules"],
    project_beacon: "AGENTS.md",
  },
  watch: {
    paths: ["~/agent_map.md", "~/.agents/skills"],
    cooldown_seconds: 10,
  },
  tidy: {
    enabled: false,
    downloads_archive_days: 7,
    home_whitelist: [
      "Applications", "Desktop", "Documents", "Downloads", "Library",
      "Movies", "Music", "Pictures", "Public",
      ".DS_Store", ".Trash", ".TemporaryItems",
      "rooms", "workspace", "archive", "secrets", "scripts", "data",
      ".agents", ".config", ".antigravity", ".cursor", ".vscode",
      ".ssh", ".gnupg", ".cache", ".local", ".npm", ".docker",
      ".cargo", ".rustup", ".pyenv", ".asdf", ".nvm",
      ".venv", "venv", "__pycache__", "node_modules", "go",
      ".git", ".gitconfig", ".gitignore",
      ".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile",
      ".curlrc", ".npmrc", ".yarnrc",
      "AGENTS.md", "CLAUDE.md", ".cursorrules", "agent_map.md",
    ],
    stray_files: {},
  },
  skill_pool: {
    sources: [],
  },
  interview: {
    industry: "",
    industry_label: "",
    organization_mode: "both",
    knowledge_layer: true,
    data_layer: true,
    maintenance_loop: true,
  },
  skills: {
    rooms: {},
    skill_category_to_room: {},
    skill_subdomain: {},
    // Neutral catch-all; de-personalized from the prototype's machine-specific default.
    default_room: "general",
  },
  budgets: {
    default_session_limit: 100_000,
    default_room_daily_limit: 500_000,
    rooms: {},
  },
};

/** Baseline capabilities every room holds when config grants none. */
export const DEFAULT_CAPABILITIES: readonly string[] = ["read_skill", "list_skills"];

// ── Errors ───────────────────────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ── Merge ──────────────────────────────────────────────────────────────────--

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Recursively merge `override` into a deep copy of `base`. Plain-object values
 * merge key-by-key; every other type (arrays, scalars) replaces wholesale — so
 * a user who sets a list in config.toml replaces the default list rather than
 * appending to it (matches the Python prototype's `_deep_merge`).
 */
export function deepMerge<T>(base: T, override: Record<string, unknown>): T {
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result as T;
}

function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function readToml(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`config file not found: ${path}`);
  }
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof TomlError ? err.message : String(err);
    throw new ConfigError(`invalid TOML in ${path}: ${detail}`);
  }
}

export function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A config-template placeholder that reached us verbatim because the MCP client
 * never substituted it: `${VAR}`, `${env:VAR}` (VS Code / Cursor), `{env:VAR}`
 * (OpenCode), `$VAR`.
 *
 * MCP clients differ sharply here, and NONE of them error on an unsubstituted
 * value — each was verified rather than assumed (2026-07-23): Claude Code
 * expands `${VAR}` and supports `${VAR:-default}`, but passes the literal
 * through when the variable is unset; Gemini CLI expands `${VAR}` and
 * substitutes an empty string when unset; OpenCode ignores `${VAR}` entirely
 * and only expands its own `{env:VAR}`; Goose performs no substitution at all;
 * Cursor documents `${env:VAR}`; Codex scrubs the environment and expands
 * nothing.
 */
const UNSUBSTITUTED_PLACEHOLDER = /^\$\{[^}]*\}$|^\{env:[^}]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Normalize a raw `AGENT_ENV_ROOM` env value into a usable room name, or `null`
 * when it carries no real information and the caller should fall back to the
 * configured default room.
 *
 * Blank and still-a-placeholder both mean "this client told us nothing". Left
 * unnormalized they became the session's ROOM NAME, and an unrecognized room
 * used to read as "no restriction configured" — a full isolation bypass
 * (verified live 2026-07-23: an empty room read a legal-room skill's entire
 * contents). isolation.ts's `roomSkillAllowed` now also fails closed on an
 * unknown room, so this normalizer is the usability half of that fix: it turns
 * "denied everything" into "correctly scoped to the default room" for the very
 * common case of an agent launched from a bare terminal with no
 * `AGENT_ENV_ROOM` set.
 */
export function normalizeRoomEnv(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (UNSUBSTITUTED_PLACEHOLDER.test(trimmed)) return null;
  return trimmed;
}

// ── Config ─────────────────────────────────────────────────────────────────--

/**
 * Merged machine settings with typed accessors. {@link Config.load} reads TOML
 * and merges it over {@link DEFAULTS}; the raw merged mapping is `.data`.
 */
export class Config {
  readonly data: RawConfig;

  constructor(data: RawConfig) {
    this.data = data;
    this.validate();
  }

  /**
   * Load config from `path` (or the default location). A missing *explicit*
   * path throws {@link ConfigError}; a missing *default* path yields the
   * built-in defaults. A malformed file always throws.
   */
  static load(path?: string | null): Config {
    let merged = structuredClone(DEFAULTS);
    if (path != null) {
      const resolved = expandUser(path);
      if (!fileExists(resolved)) {
        throw new ConfigError(`config file not found: ${resolved}`);
      }
      merged = deepMerge(merged, readToml(resolved));
    } else if (fileExists(DEFAULT_CONFIG_PATH)) {
      merged = deepMerge(merged, readToml(DEFAULT_CONFIG_PATH));
    }
    return new Config(merged);
  }

  /** A Config built purely from the built-in defaults (no file). */
  static defaults(): Config {
    return new Config(structuredClone(DEFAULTS));
  }

  // ── Validation ─────────────────────────────────────────────────────────--
  private validate(): void {
    const d = this.data;
    if (typeof d.paths?.home !== "string") {
      throw new ConfigError("paths.home must be a string");
    }
    for (const key of ["skip_dirs", "project_signatures", "skip_list"] as const) {
      const val = d.discovery?.[key];
      if (val !== undefined && !Array.isArray(val)) {
        throw new ConfigError(`discovery.${key} must be a list`);
      }
    }
    const rooms = d.skills?.rooms;
    if (!isPlainObject(rooms)) {
      throw new ConfigError("skills.rooms must be a table");
    }
    for (const [name, room] of Object.entries(rooms)) {
      if (!isPlainObject(room) || !("skills" in room)) {
        throw new ConfigError(`skills.rooms.${name} must define a skills list`);
      }
      if (!Array.isArray((room as RawRoom).skills)) {
        throw new ConfigError(`skills.rooms.${name}.skills must be a list`);
      }
    }
  }

  // ── Typed accessors ────────────────────────────────────────────────────--
  get schemaVersion(): string {
    return this.data.schema_version ?? SCHEMA_VERSION;
  }
  get homeTemplate(): string {
    return this.data.paths.home;
  }
  get skillsDirTemplate(): string {
    return this.data.paths.skills_dir;
  }
  get stateDirTemplate(): string {
    return this.data.paths.state_dir;
  }
  get scanHome(): boolean {
    return Boolean(this.data.discovery.scan_home);
  }
  get skipDirs(): Set<string> {
    return new Set(this.data.discovery.skip_dirs);
  }
  get projectSignatures(): string[] {
    return [...this.data.discovery.project_signatures];
  }
  get skipList(): string[] {
    return [...(this.data.discovery.skip_list ?? [])];
  }
  get homeBeaconTargets(): string[] {
    return [...this.data.beacons.home_targets];
  }
  get projectBeacon(): string {
    return this.data.beacons.project_beacon;
  }
  get watchPaths(): string[] {
    return [...this.data.watch.paths];
  }
  get watchCooldown(): number {
    return Number(this.data.watch.cooldown_seconds);
  }
  get tidyEnabled(): boolean {
    return Boolean(this.data.tidy.enabled);
  }
  get downloadsArchiveDays(): number {
    return Number(this.data.tidy.downloads_archive_days);
  }
  get homeWhitelist(): Set<string> {
    return new Set(this.data.tidy.home_whitelist);
  }
  get strayFiles(): Record<string, string> {
    return { ...this.data.tidy.stray_files };
  }
  get skillPoolSources(): Array<{ source: string; into: string }> {
    return [...this.data.skill_pool.sources];
  }
  get organizationMode(): string {
    return this.data.interview?.organization_mode ?? "both";
  }
  get interviewFlags(): RawConfig["interview"] {
    return { ...this.data.interview };
  }
  get roomSkills(): Record<string, RawRoom> {
    return this.data.skills.rooms;
  }
  get skillCategoryToRoom(): Record<string, string> {
    return { ...(this.data.skills.skill_category_to_room ?? {}) };
  }
  /** Per-skill sub-domain hint map (skill → "label" or "room/label"). */
  get skillSubdomains(): Record<string, string> {
    return { ...(this.data.skills.skill_subdomain ?? {}) };
  }
  get skillDefaultRoom(): string {
    return this.data.skills.default_room ?? "general";
  }
  get defaultSessionLimit(): number {
    return Number(this.data.budgets.default_session_limit);
  }
  get defaultRoomDailyLimit(): number {
    return Number(this.data.budgets.default_room_daily_limit);
  }

  /**
   * Is `room` an actually-configured room (has a `[skills.rooms.<room>]`
   * section)?
   *
   * Load-bearing for the isolation boundary: {@link roomSkillSet} returns an
   * empty set BOTH for a configured room that lists no skills (legitimately
   * unrestricted) and for a room that does not exist at all (a typo, or an
   * unexpanded `${AGENT_ENV_ROOM}` placeholder arriving as a literal). Those
   * two cases must not be conflated — isolation.ts's `roomSkillAllowed` reads
   * "empty set" as "no restriction configured", so without this predicate an
   * UNKNOWN room silently grants access to every skill in the pool.
   */
  hasRoom(room: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.skills.rooms, room);
  }

  /** Skills allowed for a room (empty set ⇒ no room-skill restriction). */
  roomSkillSet(room: string): Set<string> {
    const data = this.data.skills.rooms[room];
    return new Set(data?.skills ?? []);
  }

  /** MCP server names configured for a room. */
  roomMcpServers(room: string): string[] {
    const data = this.data.skills.rooms[room];
    return (data?.mcp?.servers ?? []).map((s) => s.name ?? "");
  }

  /**
   * Capabilities for a room: configured set if present, else the baseline
   * {@link DEFAULT_CAPABILITIES}.
   */
  roomCapabilities(room: string): string[] {
    const data = this.data.skills.rooms[room];
    if (data?.capabilities && data.capabilities.length > 0) {
      return [...data.capabilities];
    }
    return [...DEFAULT_CAPABILITIES];
  }

  /**
   * Per-session token budget for a room: explicit per-room budget on the room
   * table, else `budgets.rooms[room]`, else `budgets.default_session_limit`.
   */
  roomBudget(room: string): number {
    const roomData = this.data.skills.rooms[room];
    if (typeof roomData?.budget === "number") return roomData.budget;
    const override = this.data.budgets.rooms[room];
    if (typeof override === "number") return override;
    return this.defaultSessionLimit;
  }
}

/** Convenience wrapper matching the documented public API (`loadConfig`). */
export function loadConfig(path?: string | null): Config {
  return Config.load(path);
}
