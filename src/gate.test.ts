import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { audit } from "./audit.ts";
import {
  AccessDeniedError,
  type GateContext,
  currentGateContext,
  gate,
  runWithGateContext,
} from "./gate.ts";
import { createSession } from "./isolation.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-gate-"));
});
afterEach(() => {
  // No global context to reset: `runWithGateContext` binds context per async call
  // chain, so nothing can leak between tests (the per-call equivalent of a reset).
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
    const readSkill = gate("read_skill", async (name: string) => `content:${name}`);
    const result = await runWithGateContext(
      { env: e, session: createSession({ room: "legal", env: e }) },
      () => readSkill("nda-review"),
    );
    expect(result).toBe("content:nda-review");
  });

  test("denies (and audits) when the room lacks the capability", async () => {
    const e = env();
    const readSkill = gate("read_skill", async (name: string) => `content:${name}`);

    // marketing has list_skills but NOT read_skill.
    await expect(
      runWithGateContext({ env: e, session: createSession({ room: "marketing", env: e }) }, () =>
        readSkill("case-study"),
      ),
    ).rejects.toThrow(AccessDeniedError);
    expect(audit.denialsToday("marketing", { env: e })).toBeGreaterThanOrEqual(1);
  });

  test("denies (and audits) a skill outside the room even with the capability", async () => {
    const e = env();
    const readSkill = gate("read_skill", async (name: string) => `content:${name}`);

    // legal HAS read_skill, but "restricted-skill" is not in legal's allowed skills.
    await expect(
      runWithGateContext({ env: e, session: createSession({ room: "legal", env: e }) }, () =>
        readSkill("restricted-skill"),
      ),
    ).rejects.toThrow(AccessDeniedError);
    const denials = audit.recent({ env: e, room: "legal" }).filter((x) => x.decision === "denied");
    expect(denials.some((d) => d.resource === "restricted-skill")).toBe(true);
  });

  test("a denied call does not run the wrapped function", async () => {
    const e = env();
    let ran = false;
    const readSkill = gate("read_skill", async (name: string) => {
      ran = true;
      return name;
    });
    await expect(
      runWithGateContext({ env: e, session: createSession({ room: "marketing", env: e }) }, () =>
        readSkill("case-study"),
      ),
    ).rejects.toThrow(AccessDeniedError);
    expect(ran).toBe(false);
  });

  test("non-skill tools gate on capability only (no room-skill allowlist)", async () => {
    const e = env();
    // marketing has list_skills; the first arg is NOT treated as a room-gated skill.
    const listSkills = gate("list_skills", async (q: string) => `list:${q}`);
    const result = await runWithGateContext(
      { env: e, session: createSession({ room: "marketing", env: e }) },
      () => listSkills("anything"),
    );
    expect(result).toBe("list:anything");
  });

  test("currentGateContext returns the bound context inside a scope", () => {
    const e = env();
    const session = createSession({ room: "legal", env: e });
    const ctx = runWithGateContext({ env: e, session }, () => currentGateContext());
    expect(ctx.session).toBe(session);
    expect(ctx.env).toBe(e);
    expect(ctx.session.room).toBe("legal");
  });
});

describe("gate — concurrent session context isolation", () => {
  // The production hazard this re-gate fixes: two in-process sessions with
  // gated calls interleaved. One is capability-allowed (legal HAS read_skill,
  // nda-review in-room), one is denied (marketing lacks read_skill). Each call
  // MUST evaluate against its OWN session context. A module-global context slot
  // lets the allowed session's context be live when the denied session's gated
  // call reads it → the denied call resolves → FAIL OPEN.
  //
  // This test pins the exact interleaving deterministically with a rendezvous
  // (no reliance on scheduler timing), so it is a stable RED on the module-global
  // implementation and a stable GREEN on the per-call-bound (AsyncLocalStorage)
  // fix — not a 1-in-360 flake.
  test("an interleaved denied call never reads the allowed session's context (fail-open guard)", async () => {
    const e = env();
    const legal = createSession({ room: "legal", env: e }); // HAS read_skill
    const marketing = createSession({ room: "marketing", env: e }); // lacks read_skill
    const readSkill = gate("read_skill", async (name: string) => `loaded:${name}`);

    let releaseMarketing!: () => void;
    const marketingMayFire = new Promise<void>((r) => (releaseMarketing = r));
    let releaseLegal!: () => void;
    const legalMayFinish = new Promise<void>((r) => (releaseLegal = r));

    // Marketing establishes its context first, then parks BEFORE its gated call.
    const marketingChain = runWithGateContext({ env: e, session: marketing }, async () => {
      await marketingMayFire; // resume only once legal's context is the live one
      return readSkill("nda-review"); // MUST be denied — marketing has no read_skill
    });

    // Legal establishes its context second (the last writer of a module global),
    // runs an allowed call, then parks while keeping its context live — exactly
    // when marketing fires. Under a module global, marketing would read legal's
    // context here and fail open.
    const legalChain = runWithGateContext({ env: e, session: legal }, async () => {
      const allowed = await readSkill("nda-review"); // legal: allowed
      releaseMarketing(); // marketing reads context now; module-global ⇒ legal's
      await legalMayFinish; // hold legal's scope open across marketing's read
      return allowed;
    });

    const marketingOutcome = await marketingChain.then(
      (value) => ({ denied: false, value }),
      (err) => ({
        denied: err instanceof AccessDeniedError,
        value: undefined as string | undefined,
      }),
    );
    releaseLegal();
    const legalValue = await legalChain;

    // The allowed session is unaffected; the denied session is denied against ITS
    // own context — never the allowed session's.
    expect(legalValue).toBe("loaded:nda-review");
    expect(marketingOutcome.denied).toBe(true);
    expect(marketingOutcome.value).toBeUndefined();
    // The denial is on the ledger for the denied session's own room.
    expect(audit.denialsToday("marketing", { env: e })).toBeGreaterThanOrEqual(1);
  });

  // Soak guard: many chains of all three verdict kinds interleaved with repeated
  // yields. With a shared mutable context this crosses wires non-deterministically;
  // with per-call binding every chain resolves against its own context, every run.
  test("many interleaved chains each resolve against their own context — zero crossover", async () => {
    const e = env();
    const legal = createSession({ room: "legal", env: e }); // read_skill + nda-review in-room
    const marketing = createSession({ room: "marketing", env: e }); // no read_skill
    const readSkill = gate("read_skill", async (name: string) => `loaded:${name}`);

    type Kind = "allowed" | "capDenied" | "roomDenied";
    const kinds: Array<{ kind: Kind; ctx: GateContext; skill: string }> = [
      { kind: "allowed", ctx: { env: e, session: legal }, skill: "nda-review" },
      { kind: "capDenied", ctx: { env: e, session: marketing }, skill: "nda-review" },
      { kind: "roomDenied", ctx: { env: e, session: legal }, skill: "restricted-skill" },
    ];

    const N = 90; // 270 chains, evenly split across the three kinds
    const chains = Array.from({ length: N * kinds.length }, (_, i) => {
      const spec = kinds[i % kinds.length]!;
      return runWithGateContext(spec.ctx, async () => {
        for (let y = 0; y < 3; y++) await Promise.resolve(); // interleave aggressively
        try {
          await readSkill(spec.skill);
          return { kind: spec.kind, allowed: true };
        } catch (err) {
          if (err instanceof AccessDeniedError) return { kind: spec.kind, allowed: false };
          throw err;
        }
      });
    });

    const results = await Promise.all(chains);
    for (const res of results) {
      // allowed kind must always be allowed; both denial kinds must always deny.
      expect(res.allowed).toBe(res.kind === "allowed");
    }
    // Confirm all three kinds were actually exercised (the assertion above is not vacuous).
    expect(results.some((r) => r.kind === "allowed" && r.allowed)).toBe(true);
    expect(results.some((r) => r.kind === "capDenied" && !r.allowed)).toBe(true);
    expect(results.some((r) => r.kind === "roomDenied" && !r.allowed)).toBe(true);
  });
});
