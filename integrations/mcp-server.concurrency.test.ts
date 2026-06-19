/**
 * mcp-server.concurrency.test.ts — the per-session gate-context tripwire.
 *
 * This pins the Phase 3 concurrency contract at the MCP-server layer: every
 * request handler runs inside `runWithGateContext` (AsyncLocalStorage), so two
 * requests for DIFFERENT sessions interleaved in one process can never read each
 * other's room or budget. Reintroducing a shared mutable "current session" at the
 * server layer — the exact fail-open that NO-GO'd Phase 3 — makes this go RED.
 *
 * Two complementary checks:
 *
 *   1. ALS-across-await discriminator (the precise fail-open detector). N gated
 *      calls, each bound to its own session, all suspend at a shared barrier, then
 *      resume and read `currentGateContext()`. With AsyncLocalStorage each chain
 *      reads its OWN room; with a module-global "current context" every chain
 *      reads the LAST-bound room → RED. This is the canonical test for the bug.
 *
 *   2. Server-level interleave. One server multiplexes two sessions (distinct
 *      rooms + budgets) across hundreds of interleaved tools/call requests. Every
 *      in-room read is allowed, every cross-room read denied, and each session's
 *      final budget reflects ONLY its own loads — no context or budget bleed.
 *
 * Soak-safe: explicit Environment under mkdtemp, explicit procEnv; nothing reads
 * the live machine.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "../src/config.ts";
import { closeAllDbs } from "../src/db.ts";
import { Environment } from "../src/env.ts";
import { estimateTokens } from "../src/compaction.ts";
import { AgentSession } from "../src/isolation.ts";
import { currentGateContext, gate, runWithGateContext, type GateContext } from "../src/gate.ts";
import { createMcpServer, type JsonRpcRequest, type JsonRpcResponse } from "./mcp-server.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-mcp-concur-"));
});
afterEach(() => {
  closeAllDbs();
  rmSync(dir, { recursive: true, force: true });
});

const READ_CAPS = ["read_skill", "list_skills"];

function makeEnv(rooms: Record<string, unknown>, skills: Record<string, string>): Environment {
  const stateDir = join(dir, ".agent-env");
  const skillsDir = join(dir, ".agents", "skills");
  const cfg = new Config(
    deepMerge(DEFAULTS, {
      paths: { state_dir: stateDir, skills_dir: skillsDir },
      skills: { rooms, default_room: "general" },
    }),
  );
  const env = new Environment(dir, cfg);
  for (const [name, body] of Object.entries(skills)) {
    const sdir = join(skillsDir, name);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "SKILL.md"), body);
  }
  return env;
}

function skillMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\n${body}\n`;
}

/** A barrier that releases only once `n` callers have arrived. */
function makeBarrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gateP = new Promise<void>((r) => (release = r));
  return async () => {
    arrived += 1;
    if (arrived === n) release();
    await gateP;
  };
}

// ── (1) ALS-across-await discriminator ─────────────────────────────────────--

describe("gate context: ALS isolation across an await (fail-open detector)", () => {
  test("N concurrent gated chains each keep their OWN room across a shared barrier", async () => {
    const N = 24;
    const env = makeEnv(
      Object.fromEntries(
        Array.from({ length: N }, (_, i) => [`room${i}`, { skills: [], capabilities: READ_CAPS }]),
      ),
      {},
    );

    const arrive = makeBarrier(N);
    // A gated function that suspends mid-body, THEN reads the ambient context.
    // A shared-global context would have been overwritten by the last chain to
    // bind before the barrier released; ALS keeps each chain's own.
    const probe = gate("list_skills", async () => {
      await arrive();
      return currentGateContext().session.room;
    });

    const contexts: GateContext[] = Array.from({ length: N }, (_, i) => ({
      env,
      session: new AgentSession({ room: `room${i}`, capabilities: READ_CAPS, sessionId: `s${i}` }),
    }));

    const observed = await Promise.all(
      contexts.map((ctx) => runWithGateContext(ctx, () => probe())),
    );

    // Each chain must observe its own room — not the last-bound one.
    expect(observed).toEqual(contexts.map((c) => c.session.room));
    // Sanity: had context leaked, all entries would equal the final room.
    expect(new Set(observed).size).toBe(N);
  });
});

// ── (2) Server-level interleave ────────────────────────────────────────────--

describe("MCP server: concurrent requests from different sessions stay isolated", () => {
  test("interleaved tools/call across two sessions never cross room or budget", async () => {
    const bodyA1 = "a".repeat(1200);
    const bodyA2 = "a".repeat(2000);
    const bodyB1 = "b".repeat(800);
    const bodyB2 = "b".repeat(1600);
    const env = makeEnv(
      {
        alpha: { skills: ["a1", "a2"], capabilities: READ_CAPS, budget: 100000 },
        beta: { skills: ["b1", "b2"], capabilities: READ_CAPS, budget: 100000 },
      },
      {
        a1: skillMd("a1", bodyA1),
        a2: skillMd("a2", bodyA2),
        b1: skillMd("b1", bodyB1),
        b2: skillMd("b2", bodyB2),
      },
    );

    // resolveContext keyed on a per-request _session selector.
    const sessions: Record<string, GateContext> = {
      A: { env, session: new AgentSession({ room: "alpha", capabilities: READ_CAPS, sessionId: "sess-A" }) },
      B: { env, session: new AgentSession({ room: "beta", capabilities: READ_CAPS, sessionId: "sess-B" }) },
    };
    const server = createMcpServer({
      env,
      resolveContext: (req) => {
        const sel = (req.params?._session as string) ?? "A";
        return sessions[sel]!;
      },
    });

    const callReq = (sel: "A" | "B", skill: string, id: number): JsonRpcRequest => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { _session: sel, name: "read_skill", arguments: { skill_name: skill } },
    });

    // Build a heavily interleaved request set: each session reads its own skills
    // (allowed) and the other's skills (must be denied), many rounds over.
    const reqs: JsonRpcRequest[] = [];
    let id = 0;
    for (let round = 0; round < 60; round++) {
      reqs.push(callReq("A", "a1", id++));
      reqs.push(callReq("B", "b1", id++));
      reqs.push(callReq("A", "b2", id++)); // cross-room → deny
      reqs.push(callReq("B", "a2", id++)); // cross-room → deny
      reqs.push(callReq("A", "a2", id++));
      reqs.push(callReq("B", "b2", id++));
      reqs.push(callReq("A", "b1", id++)); // cross-room → deny
      reqs.push(callReq("B", "a1", id++)); // cross-room → deny
    }

    const isErr = (r: JsonRpcResponse) => Boolean((r.result as { isError?: boolean }).isError);
    const txt = (r: JsonRpcResponse) =>
      (r.result as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

    const responses = (await Promise.all(reqs.map((r) => server.handle(r)))) as JsonRpcResponse[];

    // Map each response back to its request to assert per-request correctness.
    for (let i = 0; i < reqs.length; i++) {
      const sel = reqs[i]!.params!._session as "A" | "B";
      const skill = (reqs[i]!.params!.arguments as { skill_name: string }).skill_name;
      const ownRoom = sel === "A" ? ["a1", "a2"] : ["b1", "b2"];
      const res = responses[i]!;
      if (ownRoom.includes(skill)) {
        expect(isErr(res)).toBe(false); // own-room read allowed
      } else {
        expect(isErr(res)).toBe(true); // cross-room read denied
        expect(txt(res).toLowerCase()).toContain("denied");
      }
    }

    // Budget isolation: each session's used == sum of ITS OWN skills only
    // (same-key reloads are idempotent, cross-room reads never debit).
    const statusA = await server.handle({
      jsonrpc: "2.0",
      id: 9001,
      method: "tools/call",
      params: { _session: "A", name: "budget_status", arguments: {} },
    });
    const statusB = await server.handle({
      jsonrpc: "2.0",
      id: 9002,
      method: "tools/call",
      params: { _session: "B", name: "budget_status", arguments: {} },
    });
    const usedA = estimateTokens(skillMd("a1", bodyA1)) + estimateTokens(skillMd("a2", bodyA2));
    const usedB = estimateTokens(skillMd("b1", bodyB1)) + estimateTokens(skillMd("b2", bodyB2));
    expect(txt(statusA!)).toContain(`${usedA}/100000`);
    expect(txt(statusB!)).toContain(`${usedB}/100000`);
  });
});
