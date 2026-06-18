import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { audit } from "./audit.ts";
import { AccessDeniedError, currentGateContext, gate, setGateContext } from "./gate.ts";
import { createSession } from "./isolation.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-gate-"));
});
afterEach(() => {
  setGateContext(null); // never leak context between tests
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(
    deepMerge(DEFAULTS, {
      paths: { state_dir: join(dir, ".agent-env") },
      skills: {
        rooms: {
          legal: { skills: ["nda-review"], capabilities: ["read_skill", "list_skills"] },
          marketing: { skills: ["case-study"], capabilities: ["list_skills"] },
        },
      },
    }),
  );
  return new Environment(dir, cfg);
}

describe("gate", () => {
  test("allows a wrapped call when the session has the capability and the skill is in-room", async () => {
    const e = env();
    setGateContext({ env: e, session: createSession({ room: "legal", env: e }) });
    const readSkill = gate("read_skill", async (name: string) => `content:${name}`);
    expect(await readSkill("nda-review")).toBe("content:nda-review");
  });

  test("denies (and audits) when the room lacks the capability", async () => {
    const e = env();
    setGateContext({ env: e, session: createSession({ room: "marketing", env: e }) });
    const readSkill = gate("read_skill", async (name: string) => `content:${name}`);

    // marketing has list_skills but NOT read_skill.
    await expect(readSkill("case-study")).rejects.toThrow(AccessDeniedError);
    expect(audit.denialsToday("marketing", { env: e })).toBeGreaterThanOrEqual(1);
  });

  test("denies (and audits) a skill outside the room even with the capability", async () => {
    const e = env();
    setGateContext({ env: e, session: createSession({ room: "legal", env: e }) });
    const readSkill = gate("read_skill", async (name: string) => `content:${name}`);

    // legal HAS read_skill, but "payroll" is not in legal's allowed skills.
    await expect(readSkill("payroll")).rejects.toThrow(AccessDeniedError);
    const denials = audit.recent({ env: e, room: "legal" }).filter((x) => x.decision === "denied");
    expect(denials.some((d) => d.resource === "payroll")).toBe(true);
  });

  test("a denied call does not run the wrapped function", async () => {
    const e = env();
    setGateContext({ env: e, session: createSession({ room: "marketing", env: e }) });
    let ran = false;
    const readSkill = gate("read_skill", async (name: string) => {
      ran = true;
      return name;
    });
    await expect(readSkill("case-study")).rejects.toThrow(AccessDeniedError);
    expect(ran).toBe(false);
  });

  test("non-skill tools gate on capability only (no room-skill allowlist)", async () => {
    const e = env();
    setGateContext({ env: e, session: createSession({ room: "marketing", env: e }) });
    // marketing has list_skills; the first arg is NOT treated as a room-gated skill.
    const listSkills = gate("list_skills", async (q: string) => `list:${q}`);
    expect(await listSkills("anything")).toBe("list:anything");
  });

  test("currentGateContext returns the explicitly set context", () => {
    const e = env();
    const session = createSession({ room: "legal", env: e });
    setGateContext({ env: e, session });
    const ctx = currentGateContext();
    expect(ctx.session).toBe(session);
    expect(ctx.env).toBe(e);
    expect(ctx.session.room).toBe("legal");
  });
});
