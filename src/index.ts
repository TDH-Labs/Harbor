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
  normalizeRoomEnv,
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
  budgetClass,
  buildAudit,
  buildBudgets,
  buildHealth,
  buildHypervisor,
  buildMcpStatus,
  buildRooms,
  buildScheduler,
  buildSessions,
  buildSkillHealth,
  buildSkills,
  createDashboardApp,
  startDashboard,
} from "./dashboard.ts";
export type {
  AuditResponse,
  BudgetClass,
  BudgetsResponse,
  DashboardServer,
  HealthResponse,
  HypervisorResponse,
  LiveMessage,
  McpRoomStatus,
  McpServerStatus,
  McpStatusResponse,
  RoomsResponse,
  SchedulerResponse,
  SessionsResponse,
  SkillHealthResponse,
  SkillRoomHealth,
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

// ── Hypervisor primitives (Phase 3 — in-process, no bridge) ───────────────────-
export { spawn, awaitExit, listActiveSpawns, SpawnTimeoutError } from "./spawn.ts";
export type { HarborChildProcess, HarborSpawnOptions, SpawnInfo } from "./spawn.ts";

export { checkBudget, spendBudget, BudgetExceededError } from "./budget.ts";
export type { BudgetResult, BudgetOptions } from "./budget.ts";

export { gate, AccessDeniedError, runWithGateContext, currentGateContext } from "./gate.ts";
export type { GateContext } from "./gate.ts";

export {
  audit,
  allow as auditAllow,
  deny as auditDeny,
  recent as auditRecent,
  denialsToday as auditDenialsTodayFor,
  onHypervisorEvent,
  emitHypervisorEvent,
} from "./audit.ts";
export type { HypervisorEvent, HypervisorEventKind, HypervisorEventListener } from "./audit.ts";

export { evict, lru as evictLru, retrieve as evictRetrieve, stats as evictStats } from "./evict.ts";
export type { EvictStats, EvictOptions, EvictLruOptions } from "./evict.ts";

// ── Skill / MCP tooling (Phase 4 — consumed by Phase 5's MCP server) ──────────-
export {
  assignCategorizedSkills,
  assignRooms,
  computeAssignments,
  findSkillDir,
  generateMasterIndex,
  generateRoomIndexes,
  getAllSkillNames,
  getSkill,
  getSkillDescription,
  listSkills,
  renderRoomIndex,
} from "./skills.ts";
export type { SkillRecord, SkillDetail, RoomIndexResult } from "./skills.ts";

export {
  checkCommand,
  checkEnvVars,
  extractEnvVars,
  generateRoomConfig,
  generateRoomConfigs,
  mergeConfigs,
  roomMcpConfig,
  roomsWithMcp,
  testConnect,
  validateAllRooms,
  validateRoom,
  validateServer,
  validateServerShape,
} from "./mcp.ts";
export type {
  CheckResult,
  McpConfig,
  McpServerEntry,
  MergeOptions,
  RoomValidation,
  ServerValidation,
  ValidateOptions,
} from "./mcp.ts";

export { scaffold, inferCategory, inferPrompt, nameToTags, SkillCreateError } from "./skill-create.ts";
export type { ScaffoldOptions, ScaffoldResult } from "./skill-create.ts";

export { install, SkillInstallError } from "./skill-install.ts";
export type { InstallOptions, InstallResult } from "./skill-install.ts";

export {
  assignOrphans,
  assignOrphansAndReload,
  deriveRoomSignals,
  getOrphanSkills,
  scoreSkillForRooms,
} from "./skill-assign.ts";
export type { AssignMode, AssignOptions, AssignResult, OrphanSuggestion } from "./skill-assign.ts";

export { addSkillToRoom, reloadEnv, ConfigEditError } from "./config-edit.ts";
export type { EditResult } from "./config-edit.ts";

// ── Agent integrations (Phase 5) ──────────────────────────────────────────────
// The MCP server (Tier 1) and Pi extension (Tier 2) live under `integrations/`
// and are reached via the `harbor/integrations/*` subpath exports (they import
// `harbor` themselves). The install command's config-emission API is core:
export { AGENT_IDS, applyConfig, emitSnippet, renderSnippet } from "./install.ts";
export type {
  AgentId,
  ApplyOptions,
  ApplyResult,
  ConfigFormat,
  EmitOptions,
  InstallSnippet,
} from "./install.ts";

// ── CLI command tree (extensible by later phases) ────────────────────────────-
export { main as cli, commonArgs, envFromArgs, setupTree } from "./cli.ts";
