/**
 * pi.test.ts — Tier 2 in-process integration tests.
 *
 * Drives the Pi tool functions in-process and asserts the resulting Harbor SQLite
 * state (budget debited in compaction.db, denial recorded in isolation.db), the
 * exact contract the phase requires: "extension calls → harbor functions → verify
 * SQLite state". Soak-safe: explicit Environment under mkdtemp, explicit procEnv.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Acceptance criterion: `import { gate, checkBudget } from 'harbor-tugboat'` works.
import { gate, checkBudget } from "harbor-tugboat";

import { Config, DEFAULTS, deepMerge } from "../src/config.ts";
import { closeAllDbs } from "../src/db.ts";
import { Environment } from "../src/env.ts";
import { AgentSession } from "../src/isolation.ts";
import { auditRead } from "../src/isolation.ts";
import type { GateContext } from "../src/gate.ts";
import {
  listSkillsTool,
  piContext,
  readSkill,
  registerHarborSkills,
  type PiToolDefinition,
} from "./pi.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-pi-"));
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

function skillMd(name: string, body = "Do the thing."): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\n${body}\n`;
}

function ctxFor(env: Environment, room: string, sessionId: string): GateContext {
  return { env, session: new AgentSession({ room, capabilities: READ_CAPS, sessionId }) };
}

describe("self-import contract", () => {
  test("gate and checkBudget import from 'harbor-tugboat'", () => {
    expect(typeof gate).toBe("function");
    expect(typeof checkBudget).toBe("function");
  });
});

describe("readSkill (in-process → SQLite state)", () => {
  test("allowed read returns content AND debits the session budget", async () => {
    const body = "x".repeat(800); // ~200 tokens
    const env = makeEnv(
      { legal: { skills: ["nda-review"], capabilities: READ_CAPS, budget: 50000 } },
      { "nda-review": skillMd("nda-review", body) },
    );
    const ctx = ctxFor(env, "legal", "sess-legal");
    const res = await readSkill(ctx, "nda-review");
    expect(res.details?.error).toBeUndefined();
    expect(res.content[0]!.text).toContain(body);

    // Verify Harbor SQLite state: the budget was actually debited.
    const tokens = res.details!.tokens as number;
    expect(tokens).toBeGreaterThan(0);
    const status = checkBudget("sess-legal", "probe", 0, { env, room: "legal" });
    expect(status.used).toBe(tokens);
    expect(status.remaining).toBe(50000 - tokens);
  });

  test("cross-room read is denied AND recorded in the audit log", async () => {
    const env = makeEnv(
      {
        legal: { skills: ["nda-review"], capabilities: READ_CAPS, budget: 50000 },
        marketing: { skills: ["campaign"], capabilities: READ_CAPS, budget: 50000 },
      },
      { "nda-review": skillMd("nda-review"), campaign: skillMd("campaign") },
    );
    const ctx = ctxFor(env, "marketing", "sess-mkt");
    const res = await readSkill(ctx, "nda-review");
    expect(res.details?.error).toBe("access_denied");

    // Verify SQLite state: the denial is in isolation.db, and NO budget moved.
    const denials = auditRead(env, { room: "marketing" }).filter((e) => e.decision === "denied");
    expect(denials.some((e) => e.resource === "nda-review")).toBe(true);
    expect(checkBudget("sess-mkt", "probe", 0, { env, room: "marketing" }).used).toBe(0);
  });

  test("budget exhaustion denies the second load and records it", async () => {
    const big = "y".repeat(4000); // ~1000 tokens
    const env = makeEnv(
      { tiny: { skills: ["a", "b"], capabilities: READ_CAPS, budget: 1200 } },
      { a: skillMd("a", big), b: skillMd("b", big) },
    );
    const ctx = ctxFor(env, "tiny", "sess-tiny");
    const first = await readSkill(ctx, "a");
    expect(first.details?.error).toBeUndefined();
    const second = await readSkill(ctx, "b");
    expect(second.details?.error).toBe("budget_exceeded");
    // The budget reflects only the first (successful) load.
    const used = first.details!.tokens as number;
    expect(checkBudget("sess-tiny", "probe", 0, { env, room: "tiny" }).used).toBe(used);
  });

  test("unknown skill is a not_found result, not a throw", async () => {
    const env = makeEnv({ general: { skills: [], capabilities: READ_CAPS } }, {});
    const res = await readSkill(ctxFor(env, "general", "s1"), "nope");
    expect(res.details?.error).toBe("not_found");
  });

  test("missing capability denies and audits", async () => {
    const env = makeEnv(
      { readonly: { skills: ["doc"], capabilities: ["list_skills"], budget: 50000 } },
      { doc: skillMd("doc") },
    );
    // Session carries the room's restricted caps (no read_skill) — not READ_CAPS.
    const ctx = {
      env,
      session: new AgentSession({ room: "readonly", capabilities: ["list_skills"], sessionId: "s-ro" }),
    };
    const res = await readSkill(ctx, "doc");
    expect(res.details?.error).toBe("access_denied");
  });
});

describe("listSkillsTool", () => {
  test("lists the room's skills", async () => {
    const env = makeEnv(
      { legal: { skills: ["nda-review", "case-brief"], capabilities: READ_CAPS } },
      { "nda-review": skillMd("nda-review"), "case-brief": skillMd("case-brief") },
    );
    const res = await listSkillsTool(ctxFor(env, "legal", "s1"));
    expect(res.content[0]!.text).toContain("nda-review");
    expect(res.content[0]!.text).toContain("case-brief");
    expect(res.details?.count).toBe(2);
  });

  // B1 — a restricted session must not enumerate another room's skills via the
  // default scope or an explicit room override. Two rooms, distinct skills, marketing
  // session: it sees only `campaign`, and `room='legal'` is denied (audited).
  test("does not reveal another room's skills (default scope or explicit override)", async () => {
    const env = makeEnv(
      {
        marketing: { skills: ["campaign"], capabilities: READ_CAPS, budget: 50000 },
        legal: { skills: ["nda-review"], capabilities: READ_CAPS, budget: 50000 },
      },
      { campaign: skillMd("campaign"), "nda-review": skillMd("nda-review") },
    );
    const ctx = ctxFor(env, "marketing", "sess-mkt");

    const own = await listSkillsTool(ctx);
    expect(own.content[0]!.text).toContain("campaign");
    expect(own.content[0]!.text).not.toContain("nda-review");

    const cross = await listSkillsTool(ctx, "legal");
    expect(cross.details?.error).toBe("access_denied");
    expect(cross.content[0]!.text).not.toContain("nda-review");

    const denials = auditRead(env, { room: "marketing" }).filter((e) => e.decision === "denied");
    expect(denials.some((e) => e.capability === "list_skills" && e.resource === "legal")).toBe(true);
  });
});

describe("piContext (env-var resolution)", () => {
  test("resolves room/session from AGENT_ENV_ROOM / AGENT_ENV_SESSION", () => {
    const env = makeEnv({ legal: { skills: ["x"], capabilities: READ_CAPS } }, {});
    const ctx = piContext({ env, procEnv: { AGENT_ENV_ROOM: "legal", AGENT_ENV_SESSION: "sid-9" } });
    expect(ctx.session.room).toBe("legal");
    expect(ctx.session.sessionId).toBe("sid-9");
  });

  test("falls back to the configured default room with no env vars", () => {
    const env = makeEnv({ general: { skills: [], capabilities: READ_CAPS } }, {});
    const ctx = piContext({ env, procEnv: {} });
    expect(ctx.session.room).toBe("general");
  });
});

describe("registerHarborSkills (Pi extension adapter)", () => {
  test("registers read_skill and list_skills, and they execute", async () => {
    const body = "z".repeat(400);
    const env = makeEnv(
      { legal: { skills: ["nda-review"], capabilities: READ_CAPS, budget: 50000 } },
      { "nda-review": skillMd("nda-review", body) },
    );
    const tools: PiToolDefinition[] = [];
    const fakePi = { registerTool: (t: PiToolDefinition) => tools.push(t) };
    registerHarborSkills(fakePi, { env, procEnv: { AGENT_ENV_ROOM: "legal", AGENT_ENV_SESSION: "sess-x" } });

    expect(tools.map((t) => t.name).sort()).toEqual(["list_skills", "read_skill"]);
    for (const t of tools) expect(t.parameters).toHaveProperty("type", "object");

    const readTool = tools.find((t) => t.name === "read_skill")!;
    const out = await readTool.execute("call-1", { skill_name: "nda-review" });
    expect(out.content[0]!.text).toContain(body);
    // The adapter path debited the budget under the env-var session.
    expect(checkBudget("sess-x", "probe", 0, { env, room: "legal" }).used).toBeGreaterThan(0);

    const listTool = tools.find((t) => t.name === "list_skills")!;
    const listed = await listTool.execute("call-2", {});
    expect(listed.content[0]!.text).toContain("nda-review");
  });
});
