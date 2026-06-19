/**
 * schema.test.ts — Proves all four state databases create cleanly with the
 * column names the downstream-contract (phases/01-core.md) declares. Phase 2's
 * dashboard queries these schemas directly, so this pins the SQL contract.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompactionEngine } from "./compaction.ts";
import { Config } from "./config.ts";
import { Environment } from "./env.ts";
import { auditLog, AgentSession } from "./isolation.ts";
import { Scheduler } from "./scheduler.ts";
import { SessionTracker } from "./session.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-schema-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tables(dbPath: string): Set<string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } finally {
    db.close();
  }
}

function columns(dbPath: string, table: string): Set<string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } finally {
    db.close();
  }
}

describe("scheduler.db", () => {
  test("creates tables with the contract columns", () => {
    const dbPath = join(dir, "scheduler.db");
    new Scheduler({ db: dbPath }).close();
    const tbls = tables(dbPath);
    for (const t of ["tasks", "task_log", "room_budgets"]) expect(tbls.has(t)).toBe(true);
    const cols = columns(dbPath, "tasks");
    for (const c of [
      "id", "room", "command", "priority", "deadline", "state",
      "tokens_budget", "tokens_used", "retry_count", "created_at", "updated_at",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
  });
});

describe("compaction.db", () => {
  test("creates the archive, registry, and budget tables", () => {
    const dbPath = join(dir, "compaction.db");
    new CompactionEngine({ db: dbPath, sessionId: "s" }).close();
    // `archived_context` is the contract's "context_entries" archive.
    const tbls = tables(dbPath);
    for (const t of ["archived_context", "session_budgets", "context_registry"]) {
      expect(tbls.has(t)).toBe(true);
    }
    const budget = columns(dbPath, "session_budgets");
    for (const c of ["session_id", "token_limit", "tokens_used"]) {
      expect(budget.has(c)).toBe(true);
    }
  });
});

describe("isolation.db", () => {
  test("creates audit_log with the contract columns", () => {
    const env = new Environment(dir, Config.defaults());
    auditLog(env, new AgentSession({ room: "r" }), { event: "probe" });
    expect(tables(env.isolationDb).has("audit_log")).toBe(true);
    const cols = columns(env.isolationDb, "audit_log");
    for (const c of [
      "session_id", "room", "capability", "resource", "decision", "reason", "timestamp",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
  });
});

describe("sessions.db", () => {
  test("creates sessions + session_events with the contract columns", () => {
    const env = new Environment(dir, Config.defaults());
    const t = new SessionTracker({ env });
    t.start("ops");
    t.end();
    const tbls = tables(env.sessionsDb);
    for (const t of ["sessions", "session_events"]) expect(tbls.has(t)).toBe(true);
    const cols = columns(env.sessionsDb, "sessions");
    for (const c of [
      "id", "room", "token_limit", "tokens_used", "skill_loads", "denials",
      "started_at", "ended_at", "status",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
  });
});
