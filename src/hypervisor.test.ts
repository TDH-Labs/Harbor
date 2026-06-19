/**
 * hypervisor.test.ts — integration tests for the Phase 3 chain.
 *
 * Exercises the primitives in combination (spawn → budget → gate → audit, plus
 * evict) and the dashboard WebSocket pushing hypervisor events in real time.
 * Only throwaway local processes are spawned (echo / true) — nothing live.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { audit } from "./audit.ts";
import { BudgetExceededError, checkBudget, spendBudget } from "./budget.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { CompactionEngine } from "./compaction.ts";
import { startDashboard } from "./dashboard.ts";
import { Environment } from "./env.ts";
import { lru, retrieve, stats } from "./evict.ts";
import { AccessDeniedError, gate, runWithGateContext } from "./gate.ts";
import { createSession } from "./isolation.ts";
import { spawn } from "./spawn.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-hyp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(
    deepMerge(DEFAULTS, {
      paths: { state_dir: join(dir, ".agent-env") },
      skills: {
        rooms: { legal: { skills: ["nda-review"], capabilities: ["read_skill", "list_skills"] } },
      },
    }),
  );
  return new Environment(dir, cfg);
}

describe("hypervisor chain", () => {
  test("spawn → budget → gate → audit, sharing one session", async () => {
    const e = env();

    // spawn: Harbor owns the PID, captures exit, and seeds the session budget.
    const child = spawn("echo", ["ready"], { harborEnv: e, room: "legal", budget: 1000 });
    expect(child.pid).toBeGreaterThan(0);
    const sid = child.sessionId;
    expect(await child.exited).toBe(0);

    // budget: spawn's budget (1000) is the limit the in-process calls enforce.
    expect(checkBudget(sid, "nda-review", 300, { env: e }).ok).toBe(true);
    const spent = spendBudget(sid, "nda-review", 300, { env: e });
    expect(spent.used).toBe(300);
    expect(spent.remaining).toBe(700);
    // The child's metadata reflects the same authoritative store.
    expect(child.tokensUsed).toBe(300);
    expect(child.budgetRemaining).toBe(700);
    // A load that no longer fits is denied.
    expect(checkBudget(sid, "huge", 800, { env: e }).ok).toBe(false);

    // gate: allow the in-room skill, deny an out-of-room one — under the same session.
    const readSkill = gate("read_skill", async (name: string) => `loaded:${name}`);
    await runWithGateContext(
      { env: e, session: createSession({ room: "legal", env: e, sessionId: sid }) },
      async () => {
        expect(await readSkill("nda-review")).toBe("loaded:nda-review");
        await expect(readSkill("restricted-skill")).rejects.toThrow(AccessDeniedError);
      },
    );

    // audit: the denied gate call is on today's denial ledger for the room.
    expect(audit.denialsToday("legal", { env: e })).toBeGreaterThanOrEqual(1);
  });

  test("budget exhaustion across the in-process calls", () => {
    const e = env();
    const sid = "chain-budget";
    expect(spendBudget(sid, "a", 70, { env: e, tokenLimit: 100 }).remaining).toBe(30);
    expect(checkBudget(sid, "b", 40, { env: e }).ok).toBe(false);
    expect(() => spendBudget(sid, "b", 40, { env: e })).toThrow(BudgetExceededError);
  });

  test("evict.lru frees budget and retrieve recovers an evicted entry", () => {
    const e = env();
    const sid = "chain-evict";
    const eng = new CompactionEngine({ env: e, sessionId: sid, tokenLimit: 100 });
    eng.load("skill:x:full", "X".repeat(200)); // 50 tokens
    eng.close();
    expect(stats(sid, { env: e }).tokensUsed).toBe(50);

    const freed = lru(sid, { targetTokens: 50, env: e });
    expect(freed).toBeGreaterThanOrEqual(50);
    expect(stats(sid, { env: e }).tokensUsed).toBe(0);
    expect(retrieve(sid, "skill:x:full", { env: e })).not.toBeNull();
  });
});

describe("dashboard live hypervisor events", () => {
  test("/api/live pushes spawn, budget, and audit events in real time", async () => {
    const e = env();
    const server = startDashboard(e, { port: 0 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/live`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws open timeout")), 3000);
        ws.onopen = () => {
          clearTimeout(t);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(t);
          reject(new Error("ws error"));
        };
      });

      const seen = new Set<string>();
      const sawAll = new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`only saw hypervisor kinds: [${[...seen].join(", ")}]`)),
          3000,
        );
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { type: string; payload?: { kind?: string } };
          if (msg.type === "hypervisor" && msg.payload?.kind) {
            seen.add(msg.payload.kind);
            if (seen.has("spawn") && seen.has("budget") && seen.has("audit")) {
              clearTimeout(t);
              resolve();
            }
          }
        };
      });

      // Trigger one of each kind (all emit synchronously through the bus).
      spendBudget("ws-sess", "k", 10, { env: e, tokenLimit: 1000 }); // budget
      audit.deny("ws-sess", "read_skill", "nda", "no", { room: "legal", env: e }); // audit
      const child = spawn("true", [], { harborEnv: e, room: "legal", budget: 1000 }); // spawn
      await child.exited;

      await sawAll;
      expect(seen.has("spawn")).toBe(true);
      expect(seen.has("budget")).toBe(true);
      expect(seen.has("audit")).toBe(true);
      ws.close();
    } finally {
      server.stop();
    }
  });
});
