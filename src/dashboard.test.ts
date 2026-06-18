import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import {
  buildAudit,
  buildBudgets,
  buildHealth,
  buildScheduler,
  buildSessions,
  startDashboard,
} from "./dashboard.ts";
import { Environment } from "./env.ts";
import { AgentSession, Capability } from "./isolation.ts";
import { Scheduler } from "./scheduler.ts";
import { SessionTracker } from "./session.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-dash-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(rooms: Record<string, unknown> = {}): Environment {
  const cfg = new Config(
    deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") }, skills: { rooms } }),
  );
  return new Environment(dir, cfg);
}

describe("data builders", () => {
  test("buildHealth reports status ok, schema version, and configured rooms", () => {
    const h = buildHealth(env({ legal: { skills: [] }, devops: { skills: [] } }));
    expect(h.status).toBe("ok");
    expect(h.schemaVersion).toBe("1.0");
    expect(h.rooms.sort()).toEqual(["devops", "legal"]);
    expect(h.watcher.running).toBe(false);
  });

  test("buildScheduler: exists=false with no db; counts queued tasks once seeded", () => {
    const e = env();
    expect(buildScheduler(e).exists).toBe(false);

    const sched = new Scheduler({ env: e });
    sched.submit("a", { room: "ops" });
    sched.submit("b", { room: "ops", priority: 5 });
    sched.close();

    const out = buildScheduler(e);
    expect(out.exists).toBe(true);
    expect(out.counts["queued"]).toBe(2);
    expect(out.tasks.length).toBe(2);
  });

  test("buildAudit surfaces denials with a today counter", () => {
    const e = env();
    const s = new AgentSession({ room: "marketing", capabilities: ["read_skill"] });
    expect(() => s.check(Capability.SCHEDULE, "task:x", e)).toThrow();
    const audit = buildAudit(e);
    expect(audit.denialsToday).toBeGreaterThanOrEqual(1);
    expect(audit.entries[0]?.decision).toBe("denied");
  });

  test("buildSessions + buildBudgets reflect a tracked session", () => {
    const e = env({ legal: { skills: [] } });
    const t = new SessionTracker({ env: e, clock: () => 1000 });
    t.start("legal", { budget: 1000 });
    t.track("skill:a", 300);
    t.end("completed", "done");

    const sessions = buildSessions(e);
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]?.tokensUsed).toBe(300);

    const budgets = buildBudgets(e);
    expect(budgets.budgets["legal"]?.used).toBe(300);
    expect(budgets.budgets["legal"]?.remaining).toBe(700);
  });
});

describe("live server", () => {
  test("serves /api/health 200 with correct JSON on an ephemeral port", async () => {
    const server = startDashboard(env({ legal: { skills: [] } }), { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; rooms: string[] };
      expect(body.status).toBe("ok");
      expect(body.rooms).toContain("legal");

      const sched = await fetch(`http://127.0.0.1:${server.port}/api/scheduler`);
      expect(sched.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  test("the / route serves the dashboard HTML", async () => {
    const server = startDashboard(env(), { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Harbor Dashboard");
    } finally {
      server.stop();
    }
  });

  test("the /api/live WebSocket accepts a connection and answers ping", async () => {
    const server = startDashboard(env(), { port: 0 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/live`);
      const first = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws timeout")), 3000);
        ws.onmessage = (ev) => {
          clearTimeout(timer);
          resolve(String(ev.data));
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("ws error"));
        };
      });
      expect(JSON.parse(first).type).toBe("connected");

      const pong = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("pong timeout")), 3000);
        ws.onmessage = (ev) => {
          clearTimeout(timer);
          resolve(String(ev.data));
        };
        ws.send("ping");
      });
      expect(JSON.parse(pong).type).toBe("pong");
      ws.close();
    } finally {
      server.stop();
    }
  });
});
