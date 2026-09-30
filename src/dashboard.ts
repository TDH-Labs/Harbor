/**
 * dashboard.ts — HTTP health dashboard (Hono + Bun.serve) on port 8765.
 *
 * Serves a single-page health UI plus a typed JSON API the agent integrations
 * (Phase 5) and the dashboard frontend both consume. Port of the Python
 * prototype's `dashboard.py`.
 *
 * Behavioral-fidelity notes (from `dashboard.py`, where SPEC_TS is silent):
 *   - Default port 8765, host 127.0.0.1, `--port` override.
 *   - Budget gauge thresholds: >90% red, >70% yellow, else green.
 *   - Audit/session timestamps are epoch *seconds* (×1000 for JS Date).
 *   - Frontend auto-refreshes every 30s.
 *
 * SPEC_TS additions beyond the Python prototype: a WebSocket endpoint at
 * `/api/live` (the Python dashboard polls only). Phase 2 establishes the
 * endpoint and a broadcast hook; Phase 3 pushes hypervisor metrics through it.
 *
 * The API response shapes are a downstream contract (Phase 3 adds panels,
 * Phase 5 queries them) — each is a named exported interface.
 */
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Environment } from "./env.ts";
import { auditDenialsToday, auditRead } from "./isolation.ts";
import { Scheduler, TaskState } from "./scheduler.ts";
import { activeSession, listSessions } from "./session.ts";
import { SYNC_STAMP } from "./sync.ts";
import { watcherStatus } from "./watch.ts";
import { onHypervisorEvent } from "./audit.ts";
import { listActiveSpawns, type SpawnInfo } from "./spawn.ts";
import { computeAssignments } from "./skills.ts";
import { checkCommand, checkEnvVars, extractEnvVars, validateServerShape } from "./mcp.ts";

/** Default dashboard port (Python parity). */
export const DEFAULT_PORT = 8765;
/** Default bind address: loopback only. */
export const DEFAULT_HOST = "127.0.0.1";
/** Shortest shared secret the dashboard will accept. */
export const MIN_TOKEN_LENGTH = 16;
const AUTH_COOKIE = "harbor_dash";

// ── Response contracts ────────────────────────────────────────────────────────

export interface BeaconHealth {
  exists: boolean;
  ageMinutes: number | null;
  sizeBytes: number;
  fresh: boolean;
}
export interface HealthResponse {
  status: "ok";
  timestamp: string;
  schemaVersion: string;
  root: string;
  watcher: { running: boolean; pid: number | null };
  beacons: Record<string, BeaconHealth>;
  skillsPool: { exists: boolean; totalSkills: number; healthy: boolean };
  rooms: string[];
  fswatch: boolean;
}

export interface RoomInfo {
  description: string;
  skillCount: number;
  hasIndex: boolean;
  hasRules: boolean;
  indexAgeMinutes: number | null;
}
export type RoomsResponse = Record<string, RoomInfo>;

export interface SkillsResponse {
  total: number;
  assigned: number;
  unassigned: number;
  byRoom: Record<string, number>;
}

/** Skill health panel: counts by room, orphan count, per-room index freshness. */
export interface SkillRoomHealth {
  skillCount: number;
  hasIndex: boolean;
  indexAgeMinutes: number | null;
}
export interface SkillHealthResponse {
  total: number;
  assigned: number;
  /** Skills in the pool assigned to no room (before the default-room fallback). */
  orphans: number;
  orphanNames: string[];
  byRoom: Record<string, SkillRoomHealth>;
}

/** MCP server status panel: per-room servers with lightweight health checks. */
export interface McpServerStatus {
  name: string;
  command: string;
  /** Command resolves on PATH / as an executable path. */
  commandOk: boolean;
  /** All referenced env vars are set. */
  envOk: boolean;
  /** Structural validity (declares name + command). */
  valid: boolean;
}
export interface McpRoomStatus {
  servers: McpServerStatus[];
  /** True when every server in the room is valid + command-resolvable + env-ok. */
  healthy: boolean;
}
export type McpStatusResponse = Record<string, McpRoomStatus>;

export interface SchedulerTaskRow {
  id: string;
  room: string;
  name: string;
  state: string;
  priority: number;
  createdAt: number;
  result: string;
}
export interface SchedulerResponse {
  exists: boolean;
  tasks: SchedulerTaskRow[];
  counts: Record<string, number>;
}

/** Budget gauge color band. Thresholds match the Python prototype: >90 red, >70 yellow, else green. */
export type BudgetClass = "green" | "yellow" | "red";

/**
 * Classify a usage percentage into a gauge color band. This is the single source
 * of truth for the >90% red / >70% yellow / else green thresholds — the dashboard
 * frontend consumes {@link BudgetRow.classified} rather than re-deriving them.
 */
export function budgetClass(percent: number): BudgetClass {
  if (percent > 90) return "red";
  if (percent > 70) return "yellow";
  return "green";
}

export interface BudgetRow {
  limit: number;
  used: number;
  remaining: number;
  percent: number;
  classified: BudgetClass;
}
export interface BudgetsResponse {
  budgets: Record<string, BudgetRow>;
  activeSession: string | null;
}

export interface AuditRow {
  timestamp: number;
  room: string;
  event: string;
  capability: string;
  resource: string;
  decision: string;
  reason: string;
}
export interface AuditResponse {
  entries: AuditRow[];
  denialsToday: number;
}

export interface SessionRow {
  sessionId: string;
  room: string;
  startedAt: number;
  endedAt: number | null;
  tokenLimit: number;
  tokensUsed: number;
  status: string;
  summary: string;
}
export interface SessionsResponse {
  sessions: SessionRow[];
}

/** Hypervisor panel data: the spawns this dashboard process currently owns. */
export interface HypervisorResponse {
  activeSpawns: SpawnInfo[];
  count: number;
}

/** WebSocket message envelope (`/api/live`). Typed so Phase 3 can add event kinds. */
export interface LiveMessage {
  type: "connected" | "pong" | "health" | string;
  payload?: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ageMinutes(path: string): number | null {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 60000;
  } catch {
    return null;
  }
}

function countSkills(skillsDir: string): number {
  if (!existsSync(skillsDir)) return 0;
  let total = 0;
  for (const name of readdirSync(skillsDir)) {
    const flat = join(skillsDir, name);
    try {
      if (!statSync(flat).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(flat, "SKILL.md"))) {
      total += 1;
      continue;
    }
    // nested category dir → count its skill subdirs
    try {
      for (const sub of readdirSync(flat)) {
        if (existsSync(join(flat, sub, "SKILL.md"))) total += 1;
      }
    } catch {
      // not a category dir
    }
  }
  return total;
}

// ── Data builders (pure reads — no server needed) ─────────────────────────────

export function buildHealth(env: Environment): HealthResponse {
  const beacons: Record<string, BeaconHealth> = {};
  for (const target of env.config.homeBeaconTargets) {
    const path = join(env.root, target);
    const exists = existsSync(path);
    let sizeBytes = 0;
    let fresh = false;
    if (exists) {
      try {
        sizeBytes = statSync(path).size;
        fresh = readFileSync(path, "utf8").includes(SYNC_STAMP);
      } catch {
        // unreadable
      }
    }
    beacons[target] = { exists, ageMinutes: ageMinutes(path), sizeBytes, fresh };
  }
  const skillsDir = env.skillsDir;
  const totalSkills = countSkills(skillsDir);
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    schemaVersion: env.config.schemaVersion,
    root: env.root,
    watcher: watcherStatus(env),
    beacons,
    skillsPool: { exists: existsSync(skillsDir), totalSkills, healthy: totalSkills >= 0 },
    rooms: Object.keys(env.config.roomSkills),
    fswatch: true,
  };
}

export function buildRooms(env: Environment): RoomsResponse {
  const out: RoomsResponse = {};
  for (const [room, data] of Object.entries(env.config.roomSkills)) {
    const indexPath = join(env.rooms, room, "skills_index.md");
    out[room] = {
      description: data.description ?? "",
      skillCount: (data.skills ?? []).length,
      hasIndex: existsSync(indexPath),
      hasRules: existsSync(join(env.rooms, room, "room_rules.md")),
      indexAgeMinutes: ageMinutes(indexPath),
    };
  }
  return out;
}

export function buildSkills(env: Environment): SkillsResponse {
  const byRoom: Record<string, number> = {};
  const assignedNames = new Set<string>();
  for (const [room, data] of Object.entries(env.config.roomSkills)) {
    const skills = data.skills ?? [];
    byRoom[room] = skills.length;
    for (const s of skills) assignedNames.add(s);
  }
  const total = countSkills(env.skillsDir);
  const assigned = assignedNames.size;
  return { total, assigned, unassigned: Math.max(0, total - assigned), byRoom };
}

export function buildScheduler(env: Environment): SchedulerResponse {
  const counts: Record<string, number> = {};
  for (const s of Object.values(TaskState)) counts[s] = 0;
  if (!existsSync(env.schedulerDb)) {
    return { exists: false, tasks: [], counts };
  }
  const sched = new Scheduler({ env });
  try {
    const stats = sched.queueStats();
    const tasks = sched
      .listTasks()
      .slice(0, 20)
      .map((t) => ({
        id: t.id,
        room: t.room,
        name: t.name,
        state: t.state,
        priority: t.priority,
        createdAt: t.createdAt,
        result: t.resultSummary,
      }));
    return { exists: true, tasks, counts: stats.counts };
  } finally {
    sched.close();
  }
}

export function buildBudgets(env: Environment): BudgetsResponse {
  const sessions = listSessions(env, { limit: 200 });
  const budgets: Record<string, BudgetRow> = {};
  for (const s of sessions) {
    const row = budgets[s.room] ?? {
      limit: 0,
      used: 0,
      remaining: 0,
      percent: 0,
      classified: "green" as BudgetClass,
    };
    // Behavioral fidelity (dashboard.py:342 `_get_budgets`): the limit is the
    // room's *configured* budget, not whatever per-session limit a given session
    // happened to run with. `config.roomBudget` is the de-personalized analogue
    // of the prototype's hardcoded `default_budgets` dict (per-room override →
    // `budgets.rooms[room]` → `default_session_limit`).
    row.limit = env.config.roomBudget(s.room);
    row.used += s.tokensUsed;
    budgets[s.room] = row;
  }
  for (const row of Object.values(budgets)) {
    row.remaining = Math.max(0, row.limit - row.used);
    row.percent = row.limit > 0 ? Math.round((row.used / row.limit) * 1000) / 10 : 0;
    row.classified = budgetClass(row.percent);
  }
  const active = activeSession(env);
  return { budgets, activeSession: active ? active.sessionId : null };
}

export function buildAudit(env: Environment): AuditResponse {
  if (!existsSync(env.isolationDb)) return { entries: [], denialsToday: 0 };
  const entries = auditRead(env, { limit: 30 }).map((e) => ({
    timestamp: e.timestamp,
    room: e.room,
    event: e.event,
    capability: e.capability,
    resource: e.resource,
    decision: e.decision,
    reason: e.reason,
  }));
  return { entries, denialsToday: auditDenialsToday(env) };
}

export function buildSessions(env: Environment): SessionsResponse {
  const sessions = listSessions(env, { limit: 15 }).map((s) => ({
    sessionId: s.sessionId,
    room: s.room,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    tokenLimit: s.tokenLimit,
    tokensUsed: s.tokensUsed,
    status: s.status,
    summary: s.summary,
  }));
  return { sessions };
}

/**
 * Active hypervisor spawns. In-process only — reflects the spawns THIS process
 * owns (the dashboard host / an integration), not spawns in other processes.
 */
export function buildHypervisor(): HypervisorResponse {
  const activeSpawns = listActiveSpawns();
  return { activeSpawns, count: activeSpawns.length };
}

/**
 * Skill health panel data: per-room skill counts + index freshness, plus the
 * orphan set (pool skills assigned to no room). Uses the same assignment logic
 * as `skills.computeAssignments` so the orphan count matches `harbor skill-assign`.
 */
export function buildSkillHealth(env: Environment): SkillHealthResponse {
  const { assignments, unassigned } = computeAssignments(env);
  const byRoom: Record<string, SkillRoomHealth> = {};
  for (const room of Object.keys(env.config.roomSkills)) {
    const indexPath = join(env.rooms, room, "skills_index.md");
    const count = Object.values(assignments).filter((r) => r === room).length;
    byRoom[room] = {
      skillCount: count,
      hasIndex: existsSync(indexPath),
      indexAgeMinutes: ageMinutes(indexPath),
    };
  }
  const total = countSkills(env.skillsDir);
  return {
    total,
    assigned: total - unassigned.length,
    orphans: unassigned.length,
    orphanNames: unassigned,
    byRoom,
  };
}

/**
 * MCP server status panel data: per-room servers with lightweight (no-spawn)
 * health — command resolution, env-var presence, and structural validity.
 * Connectivity probing is intentionally omitted here (it would spawn processes
 * on every dashboard poll); `harbor mcp-check --connectivity` does the deep test.
 */
export function buildMcpStatus(env: Environment): McpStatusResponse {
  const out: McpStatusResponse = {};
  for (const [room, data] of Object.entries(env.config.roomSkills)) {
    const servers = data.mcp?.servers ?? [];
    if (servers.length === 0) continue;
    const rows: McpServerStatus[] = servers.map((s) => {
      const commandOk = checkCommand(s.command ?? "").ok;
      const envOk = checkEnvVars(extractEnvVars(s)).every((c) => c.ok);
      const valid = validateServerShape(s).length === 0;
      return { name: s.name ?? "unnamed", command: s.command ?? "", commandOk, envOk, valid };
    });
    out[room] = { servers: rows, healthy: rows.every((r) => r.valid && r.commandOk && r.envOk) };
  }
  return out;
}

// ── HTTP app ──────────────────────────────────────────────────────────────────

const wsHelper = createBunWebSocket();

/** A live dashboard server handle. */
export interface DashboardServer {
  port: number;
  host: string;
  /** Push a message to every connected `/api/live` socket (Phase 3 hook). */
  broadcast: (message: LiveMessage) => void;
  stop: () => void;
}

/** Security settings shared by {@link createDashboardApp} and {@link startDashboard}. */
export interface DashboardSecurityOptions {
  /**
   * Shared secret (≥ {@link MIN_TOKEN_LENGTH} chars). When set, EVERY request —
   * the page, the JSON API, and the WebSocket — must present it as
   * `Authorization: Bearer <token>` or via the `harbor_dash` cookie, which a
   * one-time `GET /?token=<token>` sets (HttpOnly, SameSite=Strict) before
   * redirecting the token out of the URL.
   */
  token?: string;
  /** Extra Host names accepted when no token is set (loopback names always are). */
  allowedHosts?: string[];
}

/** Host names that mean "this machine". */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function digest(v: string): Buffer {
  return createHash("sha256").update(v).digest();
}
/** Constant-time string equality (digests first, so length does not leak). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function assertToken(token: string | undefined): void {
  if (token !== undefined && token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`dashboard token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
}

/**
 * Build the Hono app (routes only — no port bound). Useful for `app.fetch` tests.
 *
 * Request guards, in order:
 *  1. **Origin** — a request carrying an `Origin` must be same-origin. A page on
 *     another site (including one that DNS-rebound to this host) can never read
 *     the API or open the live socket.
 *  2. **Host** — with no token, only loopback names (plus `allowedHosts`) are
 *     served, which is what defeats DNS rebinding against a tokenless localhost
 *     dashboard.
 *  3. **Token** — when configured, required for everything.
 */
export function createDashboardApp(env: Environment, options: DashboardSecurityOptions = {}): Hono {
  assertToken(options.token);
  const app = new Hono();
  const allowedHosts = new Set([...(options.allowedHosts ?? [])].map((h) => h.toLowerCase()));

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);

    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === url.host;
      } catch {
        // "null" or garbage: not same-origin
      }
      if (!sameOrigin) return c.text("forbidden: cross-origin request", 403);
    }

    if (!options.token && !isLoopbackHost(url.hostname) && !allowedHosts.has(url.hostname.toLowerCase())) {
      return c.text("forbidden: unrecognized Host", 403);
    }

    if (options.token) {
      const bearer = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      const cookie = getCookie(c, AUTH_COOKIE);
      const authed =
        (bearer !== undefined && safeEqual(bearer, options.token)) ||
        (cookie !== undefined && safeEqual(cookie, options.token));
      if (!authed) {
        const q = url.searchParams.get("token");
        if (c.req.method === "GET" && q !== null && safeEqual(q, options.token)) {
          setCookie(c, AUTH_COOKIE, options.token, {
            httpOnly: true,
            sameSite: "Strict",
            path: "/",
            secure: url.protocol === "https:",
            maxAge: 8 * 60 * 60,
          });
          url.searchParams.delete("token");
          return c.redirect(url.pathname + url.search, 302);
        }
        if (q !== null) deleteCookie(c, AUTH_COOKIE, { path: "/" });
        c.header("WWW-Authenticate", "Bearer");
        return c.text("unauthorized", 401);
      }
    }

    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });

  app.get("/", (c) => {
    // A fresh nonce per response: only THIS page's own script and stylesheet
    // run, so markup that slipped past escaping still cannot execute.
    const nonce = randomBytes(16).toString("base64");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        `connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    c.header("X-Frame-Options", "DENY");
    return c.html(renderDashboard(nonce));
  });
  app.get("/api/health", (c) => c.json(buildHealth(env)));
  app.get("/api/rooms", (c) => c.json(buildRooms(env)));
  app.get("/api/skills", (c) => c.json(buildSkills(env)));
  app.get("/api/skill-health", (c) => c.json(buildSkillHealth(env)));
  app.get("/api/mcp", (c) => c.json(buildMcpStatus(env)));
  app.get("/api/scheduler", (c) => c.json(buildScheduler(env)));
  app.get("/api/budgets", (c) => c.json(buildBudgets(env)));
  app.get("/api/audit", (c) => c.json(buildAudit(env)));
  app.get("/api/sessions", (c) => c.json(buildSessions(env)));
  app.get("/api/hypervisor", (c) => c.json(buildHypervisor()));
  return app;
}

export interface StartDashboardOptions extends DashboardSecurityOptions {
  port?: number;
  /** Bind address (default loopback). A non-loopback host REQUIRES a token. */
  host?: string;
}

/**
 * Start the dashboard server. Pass `port: 0` to bind an ephemeral port (tests).
 * Returns a handle exposing the actual port, a broadcast hook, and `stop()`.
 *
 * Refuses (throws) to bind a non-loopback host without a token: the dashboard
 * exposes the environment's rooms, audit log and live hypervisor events, and
 * must never be network-reachable unauthenticated.
 */
export function startDashboard(env: Environment, options: StartDashboardOptions = {}): DashboardServer {
  const host = options.host ?? DEFAULT_HOST;
  assertToken(options.token);
  if (!isLoopbackHost(host) && !options.token) {
    throw new Error(
      `refusing to serve the dashboard on '${host}' without a token — ` +
        `set HARBOR_DASHBOARD_TOKEN (at least ${MIN_TOKEN_LENGTH} characters)`,
    );
  }
  const app = createDashboardApp(env, {
    ...(options.token ? { token: options.token } : {}),
    // Binding one specific non-loopback address makes that address a valid Host.
    allowedHosts: [...(options.allowedHosts ?? []), ...(isLoopbackHost(host) || host === "0.0.0.0" || host === "::" ? [] : [host])],
  });
  const sockets = new Set<{ send: (data: string) => void }>();

  app.get(
    "/api/live",
    wsHelper.upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "connected" } satisfies LiveMessage));
      },
      onMessage(evt, ws) {
        if (String(evt.data) === "ping") {
          ws.send(JSON.stringify({ type: "pong" } satisfies LiveMessage));
        }
      },
      onClose(_evt, ws) {
        sockets.delete(ws);
      },
    })),
  );

  const server = Bun.serve({
    port: options.port ?? DEFAULT_PORT,
    hostname: host,
    fetch: app.fetch,
    websocket: wsHelper.websocket,
  });

  const broadcast = (message: LiveMessage): void => {
    const data = JSON.stringify(message);
    for (const ws of sockets) ws.send(data);
  };

  // Push real-time hypervisor events (spawn/budget/gate/audit) to live sockets.
  const unsubscribe = onHypervisorEvent((event) => {
    broadcast({ type: "hypervisor", payload: event });
  });

  return {
    port: server.port ?? options.port ?? DEFAULT_PORT,
    host,
    broadcast,
    stop() {
      unsubscribe();
      server.stop(true);
    },
  };
}

// ── Frontend ──────────────────────────────────────────────────────────────────
// Single self-contained page: fetches the JSON API, renders panels, auto-refreshes
// every 30s, and opens the /api/live WebSocket for a connectivity indicator.
//
// EVERY value that came from the API or the live socket is passed through `esc()`
// before it reaches innerHTML — room names, skill names, audit strings and file
// paths are all attacker-influenceable. Bar widths are set through the CSSOM
// (not a style attribute) so the page can run under a nonce-only CSP.
// The script deliberately contains no backticks and no template placeholders:
// it lives inside a template literal.

/** The page's script, exported so its escaping can be tested without a browser. */
export const DASHBOARD_SCRIPT = String.raw`
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function get(p){ const r = await fetch(p, { credentials: 'same-origin' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
// Color band comes from the API (server-side budgetClass) — map to the CSS class.
const BAND = { green: 'g', yellow: 'y', red: 'r' };
async function fetchAll(){
  try {
    const h = await get('/api/health');
    $('health').innerHTML = 'watcher: <b>' + (h.watcher.running ? 'running (pid '+esc(h.watcher.pid)+')' : 'stopped') + '</b><br>' +
      Object.entries(h.beacons).map(([k,v]) => esc(k) + ': ' + (v.fresh ? 'fresh' : 'stale')).join('<br>');
    const sk = await get('/api/skills');
    $('skills').innerHTML = 'total <b>'+esc(sk.total)+'</b> · assigned '+esc(sk.assigned)+' · unassigned '+esc(sk.unassigned);
    const sh = await get('/api/skill-health');
    $('skillhealth').innerHTML = 'orphans: <b>'+esc(sh.orphans)+'</b> / '+esc(sh.total)+'<br>' +
      '<table>' + Object.entries(sh.byRoom).map(([k,v]) =>
        '<tr><td>'+esc(k)+'</td><td>'+esc(v.skillCount)+'</td><td>'+(v.hasIndex?(v.indexAgeMinutes!=null?esc(Math.round(v.indexAgeMinutes))+'m':'idx'):'<span class="muted">no idx</span>')+'</td></tr>').join('') + '</table>';
    const mcp = await get('/api/mcp');
    $('mcp').innerHTML = Object.keys(mcp).length
      ? '<table>' + Object.entries(mcp).flatMap(([room,rs]) => rs.servers.map(s =>
          '<tr><td>'+esc(room)+'/'+esc(s.name)+'</td><td>'+(s.commandOk?'cmd':'<span class="r">cmd</span>')+'</td><td>'+(s.envOk?'env':'<span class="r">env</span>')+'</td></tr>')).join('') + '</table>'
      : '<span class="muted">no MCP servers configured</span>';
    const rooms = await get('/api/rooms');
    $('rooms').innerHTML = '<table>' + Object.entries(rooms).map(([k,v]) =>
      '<tr><td>'+esc(k)+'</td><td>'+esc(v.skillCount)+' skills</td><td>'+(v.hasIndex?'idx':'')+'</td></tr>').join('') + '</table>';
    const sc = await get('/api/scheduler');
    $('scheduler').innerHTML = sc.exists
      ? Object.entries(sc.counts).map(([k,v]) => esc(k)+': '+esc(v)).join(' · ')
      : '<span class="muted">no scheduler.db</span>';
    const b = await get('/api/budgets');
    $('budgets').innerHTML = Object.keys(b.budgets).length
      ? Object.entries(b.budgets).map(([room,v]) =>
          esc(room)+' <div class="bar"><span class="'+(BAND[v.classified]||'g')+'" data-pct="'+esc(Math.min(100, Number(v.percent)||0))+'"></span></div> '+esc(v.used)+'/'+esc(v.limit)).join('')
      : '<span class="muted">no sessions</span>';
    document.querySelectorAll('[data-pct]').forEach((el) => { el.style.width = el.getAttribute('data-pct') + '%'; });
    const a = await get('/api/audit');
    $('audit').innerHTML = 'denials today: <b>'+esc(a.denialsToday)+'</b><br>' +
      a.entries.slice(0,8).map(e => esc(new Date(e.timestamp*1000).toLocaleTimeString())+' '+esc(e.room)+' '+esc(e.event)+' ('+esc(e.decision)+')').join('<br>');
    const s = await get('/api/sessions');
    $('sessions').innerHTML = '<table>' + s.sessions.slice(0,6).map(x =>
      '<tr><td>'+esc(x.room)+'</td><td>'+esc(x.tokensUsed)+'/'+esc(x.tokenLimit)+'</td><td>'+esc(x.status)+'</td></tr>').join('') + '</table>';
    const hv = await get('/api/hypervisor');
    $('hypervisor').innerHTML = 'active spawns: <b>'+esc(hv.count)+'</b>' + (hv.count
      ? '<table>' + hv.activeSpawns.map(x =>
          '<tr><td>'+esc(x.command)+'</td><td>'+esc(x.room)+'</td><td>'+esc(x.budgetRemaining)+'/'+esc(x.budget)+'</td></tr>').join('') + '</table>'
      : '');
  } catch (e) {
    if (String(e && e.message).indexOf('401') >= 0) $('health').textContent = 'unauthorized — open /?token=<your token> once';
  }
}
// Live hypervisor event feed (pushed over /api/live), most-recent first.
const hypEvents = [];
function pushHypEvent(e){
  hypEvents.unshift(esc(new Date((e.timestamp||0)*1000).toLocaleTimeString())+' '+esc(e.kind)+(e.event?'/'+esc(e.event):'')+' '+esc(e.room||'')+' '+esc(e.resource||''));
  if (hypEvents.length > 8) hypEvents.length = 8;
  if ($('hypfeed')) $('hypfeed').innerHTML = hypEvents.join('<br>');
}
function connectLive(){
  try {
    const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/api/live');
    ws.onopen = () => { $('live').textContent='live'; $('live').classList.add('on'); };
    ws.onclose = () => { $('live').textContent='offline'; $('live').classList.remove('on'); setTimeout(connectLive, 3000); };
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.type==='health') fetchAll(); else if (m.type==='hypervisor' && m.payload) pushHypEvent(m.payload); } catch(_){} };
  } catch (_) {}
}
fetchAll(); setInterval(fetchAll, 30000); connectLive();
`;

function renderDashboard(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Harbor Dashboard</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; padding: 1rem; background: #0f1115; color: #e6e6e6; }
  h1 { font-size: 1.1rem; margin: 0 0 .75rem; }
  .live { font-size: .75rem; padding: .1rem .5rem; border-radius: 1rem; background: #333; }
  .live.on { background: #1f7a3f; }
  .grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .panel { background: #171a21; border: 1px solid #262b35; border-radius: .5rem; padding: .75rem; }
  .panel h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: #8b93a7; margin: 0 0 .5rem; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  td, th { text-align: left; padding: .15rem .25rem; border-bottom: 1px solid #20242e; }
  .bar { height: .5rem; border-radius: .25rem; background: #2a2f3a; overflow: hidden; }
  .bar > span { display: block; height: 100%; }
  .g { background: #1f7a3f; } .y { background: #b08900; } .r { background: #b23b3b; }
  .muted { color: #6b7280; }
</style>
</head>
<body>
<h1>Harbor Dashboard <span id="live" class="live">offline</span></h1>
<div class="grid">
  <div class="panel"><h2>Watcher &amp; Beacons</h2><div id="health"></div></div>
  <div class="panel"><h2>Skill Pool</h2><div id="skills"></div></div>
  <div class="panel"><h2>Skill Health</h2><div id="skillhealth"></div></div>
  <div class="panel"><h2>MCP Servers</h2><div id="mcp"></div></div>
  <div class="panel"><h2>Rooms</h2><div id="rooms"></div></div>
  <div class="panel"><h2>Scheduler Queue</h2><div id="scheduler"></div></div>
  <div class="panel"><h2>Token Budgets</h2><div id="budgets"></div></div>
  <div class="panel"><h2>Audit Log</h2><div id="audit"></div></div>
  <div class="panel"><h2>Recent Sessions</h2><div id="sessions"></div></div>
  <div class="panel"><h2>Hypervisor</h2><div id="hypervisor"></div><div id="hypfeed" class="muted"></div></div>
</div>
<script nonce="${nonce}">${DASHBOARD_SCRIPT}</script>
</body>
</html>`;
}
