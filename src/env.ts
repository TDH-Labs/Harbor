/**
 * env.ts — Resolve every path from a root + Config.
 *
 * Every filesystem operation in Harbor flows through an {@link Environment}: it
 * owns the root directory and derives every other path from it. This is what
 * makes the modules testable against a temp-dir root and keeps the package free
 * of hardcoded home paths (BUILD_BRIEF §3 — home resolves via `os.homedir()`).
 *
 * Path templates in config use "~" to mean "relative to the environment root":
 * "~" alone is the root, "~/.agents/skills" is `root/.agents/skills`. An
 * absolute template is used as-is; a bare relative template joins to the root.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { Config } from "./config.ts";

/** Root directory plus every path derived from it, backed by a {@link Config}. */
export class Environment {
  readonly root: string;
  readonly config: Config;
  /**
   * The config.toml this Environment was loaded from, if any. Null when built
   * from defaults or an in-memory Config.
   */
  readonly configPath: string | null;

  constructor(root: string, config: Config, configPath: string | null = null) {
    this.root = root;
    this.config = config;
    this.configPath = configPath;
  }

  /**
   * Build an Environment.
   *
   * @param config  A path to config.toml, an already-loaded {@link Config}, or
   *   null for the default location / built-in defaults.
   * @param root    Explicit root override; otherwise derived from the config's
   *   `paths.home` ("~" ⇒ `os.homedir()`).
   */
  static load(config?: string | Config | null, root?: string | null): Environment {
    let cfg: Config;
    let cfgFile: string | null;
    if (config instanceof Config) {
      cfg = config;
      cfgFile = null;
    } else {
      cfg = Config.load(config ?? null);
      cfgFile = config ?? null;
    }
    const rootPath =
      root != null ? root : resolveHome(cfg.homeTemplate);
    return new Environment(rootPath, cfg, cfgFile);
  }

  /**
   * The process-wide default Environment, lazily loaded from the default config
   * location and cached. The hypervisor primitives ({@link spawn}, budget, gate,
   * audit, evict) call this when no explicit `env` is supplied so the spec's
   * short call forms (e.g. `checkBudget(id, key, n)`) work in production. Tests
   * always pass an explicit env and never hit this path.
   */
  private static _default: Environment | null = null;
  static default(): Environment {
    return (Environment._default ??= Environment.load());
  }

  // ── Template resolution ──────────────────────────────────────────────────
  /** Resolve a config path template against the root. */
  resolve(template: string): string {
    const t = String(template);
    if (t === "~") return this.root;
    if (t.startsWith("~/")) return join(this.root, t.slice(2));
    return isAbsolute(t) ? t : join(this.root, t);
  }

  // ── Standard derived paths ─────────────────────────────────────────────--
  get agentMap(): string {
    return join(this.root, "agent_map.md");
  }
  get workspace(): string {
    return join(this.root, "workspace");
  }
  get rooms(): string {
    return join(this.root, "rooms");
  }
  get dataDir(): string {
    return join(this.root, "data");
  }
  get skillsDir(): string {
    return this.resolve(this.config.skillsDirTemplate);
  }
  get stateDir(): string {
    return this.resolve(this.config.stateDirTemplate);
  }
  get versionFile(): string {
    return join(this.stateDir, "version");
  }
  get logsDir(): string {
    return join(this.stateDir, "logs");
  }
  get watcherPidfile(): string {
    return join(this.stateDir, "watcher.pid");
  }
  get watcherLog(): string {
    return join(this.logsDir, "watcher.log");
  }
  get archiveDir(): string {
    return join(this.root, "archive");
  }
  get downloadsDir(): string {
    return join(this.root, "Downloads");
  }
  /** The root as it should appear in generated beacon text. */
  get homeStr(): string {
    return this.root;
  }

  // ── State database paths (one source for all four core modules) ──────────-
  get schedulerDb(): string {
    return join(this.stateDir, "scheduler.db");
  }
  get compactionDb(): string {
    return join(this.stateDir, "compaction.db");
  }
  get isolationDb(): string {
    return join(this.stateDir, "isolation.db");
  }
  get sessionsDb(): string {
    return join(this.stateDir, "sessions.db");
  }
  get sessionsDir(): string {
    return join(this.stateDir, "sessions");
  }

  // ── Resolved collections ─────────────────────────────────────────────────
  watchPaths(): string[] {
    return this.config.watchPaths.map((p) => this.resolve(p));
  }
}

function resolveHome(homeTemplate: string): string {
  if (homeTemplate === "~") return homedir();
  if (homeTemplate.startsWith("~/")) return join(homedir(), homeTemplate.slice(2));
  return homeTemplate;
}
