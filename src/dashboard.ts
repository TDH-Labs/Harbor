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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Environment } from "./env.ts";
import { auditDenialsToday, auditRead } from "./isolation.ts";
import { Scheduler, TaskState } from "./scheduler.ts";
import { activeSession, listSessions } from "./session.ts";
import { SYNC_STAMP } from "./sync.ts";
import { watcherStatus } from "./watch.ts";

/** Default dashboard port (Python parity). */
export const DEFAULT_PORT = 8765;
const HOST = "127.0.0.1";

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

export interface BudgetRow {
  limit: number;
  used: number;
  remaining: number;
  percent: number;
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
    const row = budgets[s.room] ?? { limit: 0, used: 0, remaining: 0, percent: 0 };
    // The limit is the actual per-session budget the room's sessions ran with.
    row.limit = Math.max(row.limit, s.tokenLimit);
    row.used += s.tokensUsed;
    budgets[s.room] = row;
  }
  for (const row of Object.values(budgets)) {
    row.remaining = Math.max(0, row.limit - row.used);
    row.percent = row.limit > 0 ? Math.round((row.used / row.limit) * 1000) / 10 : 0;
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

// ── HTTP app ──────────────────────────────────────────────────────────────────

const wsHelper = createBunWebSocket();

/** A live dashboard server handle. */
export interface DashboardServer {
  port: number;
  /** Push a message to every connected `/api/live` socket (Phase 3 hook). */
  broadcast: (message: LiveMessage) => void;
  stop: () => void;
}

/** Build the Hono app (routes only — no port bound). Useful for `app.fetch` tests. */
export function createDashboardApp(env: Environment): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(DASHBOARD_HTML));
  app.get("/api/health", (c) => c.json(buildHealth(env)));
  app.get("/api/rooms", (c) => c.json(buildRooms(env)));
  app.get("/api/skills", (c) => c.json(buildSkills(env)));
  app.get("/api/scheduler", (c) => c.json(buildScheduler(env)));
  app.get("/api/budgets", (c) => c.json(buildBudgets(env)));
  app.get("/api/audit", (c) => c.json(buildAudit(env)));
  app.get("/api/sessions", (c) => c.json(buildSessions(env)));
  return app;
}

/**
 * Start the dashboard server. Pass `port: 0` to bind an ephemeral port (tests).
 * Returns a handle exposing the actual port, a broadcast hook, and `stop()`.
 */
export function startDashboard(
  env: Environment,
  options: { port?: number } = {},
): DashboardServer {
  const app = createDashboardApp(env);
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
    hostname: HOST,
    fetch: app.fetch,
    websocket: wsHelper.websocket,
  });

  return {
    port: server.port ?? options.port ?? DEFAULT_PORT,
    broadcast(message: LiveMessage) {
      const data = JSON.stringify(message);
      for (const ws of sockets) ws.send(data);
    },
    stop() {
      server.stop(true);
    },
  };
}

// ── Frontend ──────────────────────────────────────────────────────────────────
// Single self-contained page: fetches the JSON API, renders panels, auto-refreshes
// every 30s, and opens the /api/live WebSocket for a connectivity indicator.

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Harbor Dashboard</title>
<style>
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
  <div class="panel"><h2>Rooms</h2><div id="rooms"></div></div>
  <div class="panel"><h2>Scheduler Queue</h2><div id="scheduler"></div></div>
  <div class="panel"><h2>Token Budgets</h2><div id="budgets"></div></div>
  <div class="panel"><h2>Audit Log</h2><div id="audit"></div></div>
  <div class="panel"><h2>Recent Sessions</h2><div id="sessions"></div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
async function get(p){ const r = await fetch(p); return r.json(); }
function pct(p){ return p > 90 ? 'r' : p > 70 ? 'y' : 'g'; }
async function fetchAll(){
  try {
    const h = await get('/api/health');
    $('health').innerHTML = 'watcher: <b>' + (h.watcher.running ? 'running (pid '+h.watcher.pid+')' : 'stopped') + '</b><br>' +
      Object.entries(h.beacons).map(([k,v]) => k + ': ' + (v.fresh ? 'fresh' : 'stale')).join('<br>');
    const sk = await get('/api/skills');
    $('skills').innerHTML = 'total <b>'+sk.total+'</b> · assigned '+sk.assigned+' · unassigned '+sk.unassigned;
    const rooms = await get('/api/rooms');
    $('rooms').innerHTML = '<table>' + Object.entries(rooms).map(([k,v]) =>
      '<tr><td>'+k+'</td><td>'+v.skillCount+' skills</td><td>'+(v.hasIndex?'idx':'')+'</td></tr>').join('') + '</table>';
    const sc = await get('/api/scheduler');
    $('scheduler').innerHTML = sc.exists
      ? Object.entries(sc.counts).map(([k,v]) => k+': '+v).join(' · ')
      : '<span class="muted">no scheduler.db</span>';
    const b = await get('/api/budgets');
    $('budgets').innerHTML = Object.keys(b.budgets).length
      ? Object.entries(b.budgets).map(([room,v]) =>
          room+' <div class="bar"><span class="'+pct(v.percent)+'" style="width:'+Math.min(100,v.percent)+'%"></span></div> '+v.used+'/'+v.limit).join('')
      : '<span class="muted">no sessions</span>';
    const a = await get('/api/audit');
    $('audit').innerHTML = 'denials today: <b>'+a.denialsToday+'</b><br>' +
      a.entries.slice(0,8).map(e => new Date(e.timestamp*1000).toLocaleTimeString()+' '+e.room+' '+e.event+' ('+e.decision+')').join('<br>');
    const s = await get('/api/sessions');
    $('sessions').innerHTML = '<table>' + s.sessions.slice(0,6).map(x =>
      '<tr><td>'+x.room+'</td><td>'+x.tokensUsed+'/'+x.tokenLimit+'</td><td>'+x.status+'</td></tr>').join('') + '</table>';
  } catch (e) { /* transient */ }
}
function connectLive(){
  try {
    const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/api/live');
    ws.onopen = () => { $('live').textContent='live'; $('live').classList.add('on'); };
    ws.onclose = () => { $('live').textContent='offline'; $('live').classList.remove('on'); setTimeout(connectLive, 3000); };
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.type==='health') fetchAll(); } catch(_){} };
  } catch (_) {}
}
fetchAll(); setInterval(fetchAll, 30000); connectLive();
</script>
</body>
</html>`;
