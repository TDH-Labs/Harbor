import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { activeSession, listSessions, SessionTracker } from "./session.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-sess-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEnv(rooms: Record<string, unknown> = {}, budgets: Record<string, unknown> = {}): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { skills: { rooms }, budgets }));
  return new Environment(dir, cfg);
}

function tracker(env: Environment, clock = () => 1000): SessionTracker {
  return new SessionTracker({ env, clock });
}

describe("start", () => {
  test("writes state.json with config-resolved budget, caps, skills, and mcp", () => {
    const env = makeEnv({
      legal: {
        skills: ["nda-review", "case-brief"],
        capabilities: ["read_skill", "list_skills", "mcp_access"],
        mcp: { servers: [{ name: "nda-fs" }] },
      },
    });
    const t = tracker(env);
    const state = t.start("legal");
    expect(state.status).toBe("active");
    expect(state.tokenLimit).toBe(100_000); // default_session_limit
    expect(state.capabilities).toContain("mcp_access");
    expect(state.allowedSkills).toEqual(["nda-review", "case-brief"]);
    expect(state.allowedMcpServers).toEqual(["nda-fs"]);

    const onDisk = JSON.parse(readFileSync(t.stateFile, "utf8"));
    expect(onDisk.sessionId).toBe(state.sessionId);
  });

  test("budget resolves from config per-room and is overridable", () => {
    const env = makeEnv({ research: { skills: [] } }, { rooms: { research: 120_000 } });
    expect(tracker(env).start("research").tokenLimit).toBe(120_000);
    expect(tracker(env).start("research", { budget: 5000 }).tokenLimit).toBe(5000);
  });
});

describe("track", () => {
  test("debits the budget and flips to budget_exceeded at zero", () => {
    const env = makeEnv({ ops: { skills: [] } }, { rooms: { ops: 1000 } });
    const t = tracker(env);
    t.start("ops");
    expect(t.track("skill:a", 300)).toBe(true);

    const after = activeSession(env);
    expect(after?.tokensUsed).toBe(300);
    expect(after?.tokensRemaining).toBe(700);

    t.track("skill:b", 800); // 1100 > 1000
    // Once the budget is blown the session is no longer "active", so read state directly.
    expect(JSON.parse(readFileSync(t.stateFile, "utf8")).status).toBe("budget_exceeded");
  });

  test("track on a non-existent session returns false", () => {
    const env = makeEnv();
    const t = new SessionTracker({ env, sessionId: "ghost" });
    expect(t.track("k", 10)).toBe(false);
  });
});

describe("canLoad", () => {
  test("enforces budget and room-skill gating", () => {
    const env = makeEnv({ legal: { skills: ["nda-review"] } }, { rooms: { legal: 1000 } });
    const t = tracker(env);
    t.start("legal");
    expect(t.canLoad(500, "nda-review")).toEqual({ ok: true, reason: "ok" });
    expect(t.canLoad(5000, "nda-review").ok).toBe(false); // over budget
    expect(t.canLoad(10, "tax-model").ok).toBe(false); // not in room
  });
});

describe("end + rollup", () => {
  test("rolls up to sessions.db with skill-load and denial counts", () => {
    const env = makeEnv({ legal: { skills: ["nda-review"] } }, { rooms: { legal: 100_000 } });
    const t = tracker(env);
    t.start("legal", { agentId: "agent-7" });
    t.track("skill:nda-review", 1000); // context_load
    t.track("skill:case-brief", 1000, { event: "skill_load" });
    t.trackDenial("tax-model", "not in room");
    const ended = t.end("completed", "did the thing");
    expect(ended?.status).toBe("completed");

    const sessions = listSessions(env, { room: "legal" });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.status).toBe("completed");
    expect(s.tokensUsed).toBe(2000);
    expect(s.skillLoads).toBe(2);
    expect(s.denials).toBe(1);
    expect(s.summary).toBe("did the thing");
    expect(s.agentId).toBe("agent-7");
  });

  test("end on a non-existent session returns null", () => {
    const env = makeEnv();
    expect(new SessionTracker({ env, sessionId: "ghost" }).end()).toBeNull();
  });
});

describe("activeSession", () => {
  test("returns the active session, and nothing once it ends", () => {
    const env = makeEnv({ ops: { skills: [] } });
    const t = tracker(env);
    const started = t.start("ops");
    expect(activeSession(env)?.sessionId).toBe(started.sessionId);
    t.end();
    expect(activeSession(env)).toBeNull();
  });

  test("returns the most recent active session by start time", () => {
    const env = makeEnv({ ops: { skills: [] } });
    const older = new SessionTracker({ env, clock: () => 1000 });
    older.start("ops");
    const newer = new SessionTracker({ env, clock: () => 5000 });
    const newerState = newer.start("ops");
    expect(activeSession(env)?.sessionId).toBe(newerState.sessionId);
  });
});

describe("listSessions", () => {
  test("filters by room", () => {
    const env = makeEnv({ ops: { skills: [] }, legal: { skills: [] } });
    new SessionTracker({ env, clock: () => 1000 }).start("ops");
    const opsTracker = new SessionTracker({ env, clock: () => 1000 });
    opsTracker.start("ops");
    // Only ended sessions roll up to sessions.db.
    const legalT = new SessionTracker({ env, clock: () => 2000 });
    legalT.start("legal");
    legalT.end();
    expect(listSessions(env, { room: "legal" })).toHaveLength(1);
    expect(listSessions(env, { room: "ops" })).toHaveLength(0); // never ended
  });
});
