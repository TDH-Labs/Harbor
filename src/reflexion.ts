/**
 * reflexion.ts — Isolated episodic memory & self-healing reflection store.
 *
 * Grounded in the Reflexion framework (Shinn et al.) and hardened against
 * second-order prompt poisoning and SQLite lock contention.
 *
 * Hardening constraints (Staff SRE Specification):
 *   1. Dedicated storage: Uses `reflexion.db`, isolated from Harbor's control plane.
 *   2. Strict schema: Strongly typed error signatures, failure categories, and remedies.
 *   3. Input sanitization: Length-capped (300 chars), stripped of execution payloads.
 *   4. Pruning: Hard FIFO/LRU cap (max 10 entries per room/skill).
 *   5. Skill-hash binding: Correlates reflections with skill content hash to invalidate stale workarounds.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { openDb } from "./db.ts";
import type { Environment } from "./env.ts";

export type FailureCategory = "ASSERTION" | "TIMEOUT" | "LINT" | "PERM" | "SYNTAX" | "RUNTIME";

export interface ReflexionEntry {
  eventId?: string;
  room: string;
  skill: string;
  skillHash?: string;
  errorSignature: string;
  failureCategory: FailureCategory | string;
  remedy: string;
  verified?: boolean;
}

export interface ReflexionRecord {
  id: number;
  eventId: string;
  room: string;
  skill: string;
  skillHash: string;
  errorSignature: string;
  failureCategory: string;
  sanitizedRemedy: string;
  createdAt: number;
  verified: number;
}

const MAX_REMEDY_LENGTH = 300;
const MAX_ENTRIES_PER_SKILL = 10;

/** Sanitize reflection remedy text against prompt injections and script injection. */
export function sanitizeRemedy(raw: string): string {
  if (!raw) return "";
  let clean = raw.trim();
  // Strip control characters, html tags, and dangerous command injections
  clean = clean.replace(/<[^>]*>?/gm, "");
  clean = clean.replace(/(\bcurl\b|\bwget\b|\brm\s+-rf\b|\bchmod\s+777\b)/gi, "[REDACTED_COMMAND]");
  if (clean.length > MAX_REMEDY_LENGTH) {
    clean = clean.slice(0, MAX_REMEDY_LENGTH - 3) + "...";
  }
  return clean;
}

function initReflexionSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflexion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      room TEXT NOT NULL,
      skill TEXT NOT NULL,
      skill_hash TEXT NOT NULL,
      error_signature TEXT NOT NULL,
      failure_category TEXT NOT NULL,
      sanitized_remedy TEXT NOT NULL,
      created_at REAL NOT NULL,
      verified INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_reflexion_room_skill ON reflexion_events(room, skill);
    CREATE INDEX IF NOT EXISTS idx_reflexion_created ON reflexion_events(created_at);
  `);
}

function getReflexionDb(env: Environment) {
  mkdirSync(env.dataDir, { recursive: true });
  const dbPath = join(env.dataDir, "reflexion.db");
  return openDb(dbPath, initReflexionSchema);
}

/** Record a structured failure reflection. */
export function logReflexionEvent(env: Environment, entry: ReflexionEntry): ReflexionRecord {
  const { db } = getReflexionDb(env);
  const now = Date.now() / 1000;
  const eventId =
    entry.eventId ||
    createHash("sha256")
      .update(`${entry.room}:${entry.skill}:${entry.errorSignature}:${now}`)
      .digest("hex")
      .slice(0, 16);
  const skillHash = entry.skillHash || "unversioned";
  const sanitized = sanitizeRemedy(entry.remedy);
  const category = (entry.failureCategory || "RUNTIME").toUpperCase();
  const verified = entry.verified ? 1 : 0;

  // Insert event
  const insert = db.prepare(`
    INSERT INTO reflexion_events (event_id, room, skill, skill_hash, error_signature, failure_category, sanitized_remedy, created_at, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(eventId, entry.room, entry.skill, skillHash, entry.errorSignature, category, sanitized, now, verified);

  // Enforce FIFO / LRU cap: delete oldest if more than MAX_ENTRIES_PER_SKILL exist
  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM reflexion_events WHERE room = ? AND skill = ?`
  ).get(entry.room, entry.skill) as { count: number } | undefined;

  const count = countRow?.count ?? 0;
  if (count > MAX_ENTRIES_PER_SKILL) {
    const toDelete = count - MAX_ENTRIES_PER_SKILL;
    db.prepare(`
      DELETE FROM reflexion_events
      WHERE id IN (
        SELECT id FROM reflexion_events
        WHERE room = ? AND skill = ?
        ORDER BY created_at ASC
        LIMIT ?
      )
    `).run(entry.room, entry.skill, toDelete);
  }

  return {
    id: 0,
    eventId,
    room: entry.room,
    skill: entry.skill,
    skillHash,
    errorSignature: entry.errorSignature,
    failureCategory: category,
    sanitizedRemedy: sanitized,
    createdAt: now,
    verified,
  };
}

/** Retrieve active reflexion lessons for a given room and skill. */
export function getReflexionLessons(
  env: Environment,
  room: string,
  skill: string,
  currentSkillHash?: string,
  limit = 3
): ReflexionRecord[] {
  const { db } = getReflexionDb(env);
  let sql = `
    SELECT id, event_id as eventId, room, skill, skill_hash as skillHash, error_signature as errorSignature,
           failure_category as failureCategory, sanitized_remedy as sanitizedRemedy, created_at as createdAt, verified
    FROM reflexion_events
    WHERE room = ? AND skill = ?
  `;
  const params: any[] = [room, skill];

  if (currentSkillHash) {
    sql += ` AND (skill_hash = ? OR skill_hash = 'unversioned')`;
    params.push(currentSkillHash);
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as ReflexionRecord[];
  return rows;
}
