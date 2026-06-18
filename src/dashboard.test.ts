import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import {
  budgetClass,
  buildAudit,
  buildBudgets,
  buildHealth,
  buildMcpStatus,
  buildScheduler,
  buildSessions,
  buildSkillHealth,
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
    // The room's configured budget (1000) is the gauge limit — see the
    // reconciliation test below for why this is NOT the session's own tokenLimit.
    const e = env({ legal: { skills: [], budget: 1000 } });
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

  test("buildBudgets limit is the room's CONFIGURED budget, not the session's tokenLimit", () => {
    // Behavioral fidelity with dashboard.py:342 `_get_budgets`: the gauge limit is
    // the room default budget, independent of whatever per-session limit a session
    // ran with. Here the session runs with a tokenLimit of 50_000 but the room is
    // configured for 8_000 — the budget row must report 8_000, not 50_000.
    const e = env({ legal: { skills: [], budget: 8_000 } });
    const t = new SessionTracker({ env: e, clock: () => 1000 });
    t.start("legal", { budget: 50_000 });
    t.track("skill:a", 2_000);
    t.end("completed", "done");

    const row = buildBudgets(e).budgets["legal"];
    expect(row?.limit).toBe(8_000); // configured room budget — NOT the session's 50_000
    expect(row?.used).toBe(2_000);
    expect(row?.remaining).toBe(6_000);
    expect(row?.percent).toBe(25);
  });

  test("buildBudgets classifies the gauge band from the configured limit", () => {
    // used/limit = 7_500/8_000 = 93.75% → red. If the limit fell back to the
    // session's tokenLimit (50_000) the percent would be 15% → green, so this
    // also guards the limit-source reconciliation.
    const e = env({ legal: { skills: [], budget: 8_000 } });
    const t = new SessionTracker({ env: e, clock: () => 1000 });
    t.start("legal", { budget: 50_000 });
    t.track("skill:a", 7_500);
    t.end("completed", "done");

    expect(buildBudgets(e).budgets["legal"]?.classified).toBe("red");
  });
});

describe("Phase 4 panels", () => {
  function writeSkill(name: string, pool = join(dir, ".agents", "skills")): void {
    const d = join(pool, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
  }

  test("buildSkillHealth reports per-room counts + orphan set", () => {
    writeSkill("assigned-one");
    writeSkill("orphan-one");
    const e = env({ ops: { description: "Ops", skills: ["assigned-one"] } });
    const h = buildSkillHealth(e);
    expect(h.total).toBe(2);
    expect(h.orphans).toBe(1);
    expect(h.orphanNames).toEqual(["orphan-one"]);
    expect(h.byRoom.ops?.skillCount).toBe(1);
    expect(h.byRoom.ops?.hasIndex).toBe(false); // no index generated yet
  });

  test("buildMcpStatus reports per-room server health (no spawn)", () => {
    const e = env({
      devops: {
        description: "Dev",
        skills: [],
        mcp: { servers: [{ name: "filesystem", command: "echo", args: ["x"] }] },
      },
      empty: { description: "Empty", skills: [] },
    });
    const status = buildMcpStatus(e);
    expect(Object.keys(status)).toEqual(["devops"]); // empty room omitted
    expect(status.devops?.servers[0]?.commandOk).toBe(true);
    expect(status.devops?.healthy).toBe(true);
  });

  test("buildMcpStatus flags an unresolvable command", () => {
    const e = env({
      devops: {
        description: "Dev",
        skills: [],
        mcp: { servers: [{ name: "broken", command: "definitely-not-a-real-binary-xyz" }] },
      },
    });
    const status = buildMcpStatus(e);
    expect(status.devops?.servers[0]?.commandOk).toBe(false);
    expect(status.devops?.healthy).toBe(false);
  });
});

describe("budgetClass thresholds", () => {
  test(">90 red, >70 yellow, else green (boundaries)", () => {
    expect(budgetClass(91)).toBe("red");
    expect(budgetClass(71)).toBe("yellow");
    expect(budgetClass(50)).toBe("green");
    // Boundary values land in the lower band (strict >).
    expect(budgetClass(90)).toBe("yellow");
    expect(budgetClass(70)).toBe("green");
    expect(budgetClass(100)).toBe("red");
    expect(budgetClass(0)).toBe("green");
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
