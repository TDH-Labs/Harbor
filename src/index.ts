/**
 * Harbor — agent control plane (core).
 *
 * Phase 1 public surface: config + environment resolution and the four Agent OS
 * core modules (scheduler, compaction, isolation, session). Later phases import
 * these interfaces in-process.
 */

// ── Config + environment ─────────────────────────────────────────────────────
export {
  Config,
  ConfigError,
  DEFAULTS,
  DEFAULT_CAPABILITIES,
  DEFAULT_CONFIG_PATH,
  SCHEMA_VERSION,
  deepMerge,
  loadConfig,
} from "./config.ts";
export type { RawConfig, RawRoom, RawMcpServer } from "./config.ts";

export { Environment } from "./env.ts";

// ── Scheduler ────────────────────────────────────────────────────────────────
export { Scheduler, SchedulingPolicy, TaskState } from "./scheduler.ts";
export type { Task, SubmitOptions, SchedulerOptions, QueueStats } from "./scheduler.ts";

// ── Compaction ───────────────────────────────────────────────────────────────
export { CompactionEngine, BudgetError, TIER_COSTS, estimateTokens, loadSkillTier } from "./compaction.ts";
export type {
  ContextEntry,
  CompactionOptions,
  CompactionStats,
  LoadOptions,
  SkillTier,
} from "./compaction.ts";

// ── Isolation ────────────────────────────────────────────────────────────────
export {
  AgentSession,
  AccessDenied,
  Capability,
  auditLog,
  auditRead,
  auditDenialsToday,
  checkSkillAccess,
  checkMcpAccess,
  checkDataAccess,
  checkFileAccess,
  createSession,
  requireCapability,
} from "./isolation.ts";
export type {
  AgentSessionInit,
  AuditEntry,
  AuditLogInput,
  CreateSessionOptions,
  Decision,
} from "./isolation.ts";

// ── Session tracking ─────────────────────────────────────────────────────────
export { SessionTracker, listSessions, activeSession } from "./session.ts";
export type { SessionState, SessionSummary, StartOptions, TrackOptions } from "./session.ts";

// ── Beacon sync ──────────────────────────────────────────────────────────────
export {
  SYNC_STAMP,
  discoverAll,
  discoverHomeProjects,
  discoverWorkspaceProjects,
  ensureWorkspaceDir,
  fullSync,
  generateHomeAgentsMd,
  generateHomeClaudeMd,
  generateCursorrules,
  generateProjectAgentsMd,
  generateRoomIndex,
  isProjectDir,
  parseAgentMap,
  parseProjectTable,
  parseRoomTable,
  parseTable,
  runGenerate,
  writeIfChanged,
} from "./sync.ts";
export type { GenerateResult, TableRow } from "./sync.ts";

// ── Watcher ──────────────────────────────────────────────────────────────────
export {
  CooldownGate,
  PidFile,
  Watcher,
  runForeground,
  startDaemon,
  stopDaemon,
  watcherStatus,
} from "./watch.ts";
export type { SyncFn, WatcherOptions, WatcherStatus } from "./watch.ts";

// ── Dashboard ────────────────────────────────────────────────────────────────
export {
  DEFAULT_PORT,
  buildAudit,
  buildBudgets,
  buildHealth,
  buildRooms,
  buildScheduler,
  buildSessions,
  buildSkills,
  createDashboardApp,
  startDashboard,
} from "./dashboard.ts";
export type {
  AuditResponse,
  BudgetsResponse,
  DashboardServer,
  HealthResponse,
  LiveMessage,
  RoomsResponse,
  SchedulerResponse,
  SessionsResponse,
  SkillsResponse,
} from "./dashboard.ts";

// ── Benchmark ────────────────────────────────────────────────────────────────
export {
  WARMUP,
  conditionFor,
  formatSummary,
  isMeasured,
  latestReport,
  median,
  parseSessionJsonl,
  runBench,
  summarize,
} from "./bench.ts";
export type { BenchRun, BenchSummary, BenchOptions, ConditionStats, SessionMetrics } from "./bench.ts";

// ── CLI command tree (extensible by later phases) ────────────────────────────-
export { main as cli, commonArgs, envFromArgs } from "./cli.ts";
