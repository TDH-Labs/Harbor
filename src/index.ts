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
