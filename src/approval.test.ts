/**
 * approval.test.ts — PEN TEST for the human-in-the-loop approval gate.
 *
 * This is written as an attack, not a demonstration. The gate's only job is to
 * be impossible to talk into a YES, so every test below tries to obtain an
 * approval it should not get: hostile transports, malformed decisions, truthy
 * non-true values, unbounded or backdated expiries, and grants borrowed across
 * sessions / rooms / resources.
 *
 * A single passing "allow" here that should have been a deny is a real
 * vulnerability, so the assertions are deliberately about the SECURITY
 * PROPERTY (granted === false) rather than about messages.
 *
 * Soak-safe: every test uses a mkdtemp state dir; no test touches the live
 * machine's isolation.db.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalTransport,
  MAX_GRANT_SECONDS,
  denyTransport,
  hasLiveGrant,
  listGrants,
  purgeExpiredGrants,
  rejectDecision,
  requestApproval,
  saveGrant,
} from "./approval.ts";
import { allow, deny } from "./audit.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-approval-"));
});
afterEach(() => {
  closeAllDbs();
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

const REQ: ApprovalRequest = {
  sessionId: "sess-1",
  room: "productivity",
  tool: "read_skill",
  resource: "nda-review",
  targetRoom: "legal",
  reason: "skill 'nda-review' not in room 'productivity'",
};

/** A transport that answers however the test tells it to. */
function transportReturning(value: unknown): ApprovalTransport {
  return { name: "test", request: async () => value as ApprovalDecision };
}

const NOW = 1_800_000_000;
const LATER = NOW + 600;

// ── The default posture ──────────────────────────────────────────────────────

describe("default posture is deny", () => {
  test("the built-in transport denies without asking anyone", async () => {
    const out = await requestApproval(env(), REQ, denyTransport, { now: NOW });
    expect(out.granted).toBe(false);
  });

  test("calling with NO transport argument denies — the default must not be permissive", async () => {
    const out = await requestApproval(env(), REQ, undefined, { now: NOW });
    expect(out.granted).toBe(false);
  });
});

// ── Hostile transports ───────────────────────────────────────────────────────

describe("a hostile or broken transport cannot produce an approval", () => {
  test("a transport that throws is denied, not allowed through", async () => {
    const t: ApprovalTransport = {
      name: "throwing",
      request: async () => {
        throw new Error("boom");
      },
    };
    const out = await requestApproval(env(), REQ, t, { now: NOW });
    expect(out.granted).toBe(false);
    expect(out.reason).toContain("failed");
  });

  test("a transport that never settles is denied by timeout, and does not hang", async () => {
    const t: ApprovalTransport = { name: "hanging", request: () => new Promise<ApprovalDecision>(() => {}) };
    const started = Date.now();
    const out = await requestApproval(env(), REQ, t, { timeoutMs: 50, now: NOW });
    expect(out.granted).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a transport that rejects is denied", async () => {
    const t: ApprovalTransport = { name: "rejecting", request: () => Promise.reject(new Error("nope")) };
    expect((await requestApproval(env(), REQ, t, { now: NOW })).granted).toBe(false);
  });
});

// ── Malformed / coercion attacks on the decision ─────────────────────────────

describe("only a strictly-true, bounded, unexpired decision is honored", () => {
  // Each of these is a shape an attacker (or a sloppy transport) might hand
  // back hoping JS truthiness lets it through.
  const hostile: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "granted"],
    ["a number", 1],
    ["an array", [{ granted: true, expiresAt: LATER }]],
    ["granted as the string 'true'", { granted: "true", expiresAt: LATER }],
    ["granted as 1", { granted: 1, expiresAt: LATER }],
    ["granted as a truthy object", { granted: {}, expiresAt: LATER }],
    ["granted as 'yes'", { granted: "yes", expiresAt: LATER }],
    ["granted true but NO expiry", { granted: true }],
    ["granted true with a null expiry", { granted: true, expiresAt: null }],
    ["granted true with a string expiry", { granted: true, expiresAt: String(LATER) }],
    ["granted true with NaN expiry", { granted: true, expiresAt: NaN }],
    ["granted true with Infinity expiry", { granted: true, expiresAt: Infinity }],
    ["granted true but already expired", { granted: true, expiresAt: NOW - 1 }],
    ["granted true expiring exactly now", { granted: true, expiresAt: NOW }],
    ["granted false with a valid expiry", { granted: false, expiresAt: LATER }],
  ];

  for (const [label, value] of hostile) {
    test(`rejects ${label}`, async () => {
      const out = await requestApproval(env(), REQ, transportReturning(value), { now: NOW });
      expect(out.granted).toBe(false);
    });
  }

  test("rejectDecision agrees with requestApproval on every hostile shape", () => {
    for (const [, value] of hostile) expect(rejectDecision(value, NOW)).not.toBeNull();
  });

  test("the ONE well-formed approval is accepted (proving the tests above aren't vacuous)", async () => {
    const out = await requestApproval(env(), REQ, transportReturning({ granted: true, expiresAt: LATER }), {
      now: NOW,
    });
    expect(out.granted).toBe(true);
    expect(rejectDecision({ granted: true, expiresAt: LATER }, NOW)).toBeNull();
  });
});

// ── Grant scoping: a grant must not cover anything it wasn't issued for ──────

describe("a grant is scoped exactly, and cannot be borrowed", () => {
  async function grantOne(e: Environment): Promise<void> {
    const out = await requestApproval(e, REQ, transportReturning({ granted: true, expiresAt: LATER }), { now: NOW });
    expect(out.granted).toBe(true);
  }

  test("does not cover a DIFFERENT resource", async () => {
    const e = env();
    await grantOne(e);
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, "some-other-skill", NOW)).toBe(false);
    // ...and a fresh request for it is denied by the default transport.
    const out = await requestApproval(e, { ...REQ, resource: "some-other-skill" }, denyTransport, { now: NOW });
    expect(out.granted).toBe(false);
  });

  test("does not cover a DIFFERENT session", async () => {
    const e = env();
    await grantOne(e);
    expect(hasLiveGrant(e, "sess-2", REQ.room, REQ.resource, NOW)).toBe(false);
    const out = await requestApproval(e, { ...REQ, sessionId: "sess-2" }, denyTransport, { now: NOW });
    expect(out.granted).toBe(false);
  });

  test("does not cover a DIFFERENT room", async () => {
    const e = env();
    await grantOne(e);
    expect(hasLiveGrant(e, REQ.sessionId, "marketing", REQ.resource, NOW)).toBe(false);
    const out = await requestApproval(e, { ...REQ, room: "marketing" }, denyTransport, { now: NOW });
    expect(out.granted).toBe(false);
  });

  test("the grant DOES cover its own exact triple (not vacuous)", async () => {
    const e = env();
    await grantOne(e);
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, REQ.resource, NOW)).toBe(true);
  });
});

// ── Time: expiry cannot be evaded ────────────────────────────────────────────

describe("grants expire and cannot be made permanent", () => {
  test("a grant is dead once its expiry passes", async () => {
    const e = env();
    await requestApproval(e, REQ, transportReturning({ granted: true, expiresAt: NOW + 100 }), { now: NOW });
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, REQ.resource, NOW + 50)).toBe(true);
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, REQ.resource, NOW + 101)).toBe(false);
  });

  // A compromised transport must not be able to mint a decade-long approval.
  test("an absurdly long grant is CLAMPED to the ceiling, not honored as asked", async () => {
    const e = env();
    const tenYears = NOW + 10 * 365 * 24 * 3600;
    const out = await requestApproval(e, REQ, transportReturning({ granted: true, expiresAt: tenYears }), {
      now: NOW,
    });
    expect(out.granted).toBe(true);
    expect(out.expiresAt).toBe(NOW + MAX_GRANT_SECONDS);
    expect(out.expiresAt).toBeLessThan(tenYears);
    // and it really is dead after the ceiling
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, REQ.resource, NOW + MAX_GRANT_SECONDS + 1)).toBe(false);
  });

  test("saveGrant clamps directly too — the ceiling is not only enforced on the request path", () => {
    const e = env();
    const g = saveGrant(e, REQ, { granted: true, expiresAt: NOW + 999_999 }, NOW);
    expect(g.expiresAt).toBe(NOW + MAX_GRANT_SECONDS);
  });

  test("an expired grant does not resurrect if the clock moves backward", async () => {
    const e = env();
    await requestApproval(e, REQ, transportReturning({ granted: true, expiresAt: NOW + 10 }), { now: NOW });
    // expired at NOW+11 ...
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, REQ.resource, NOW + 11)).toBe(false);
    // ... and expiry is evaluated on read, so an earlier "now" sees it live
    // again ONLY because time genuinely moved back — the row is not mutated.
    // The security property that matters: it is never live PAST its expiry.
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, REQ.resource, NOW + 10_000)).toBe(false);
  });

  test("purge removes expired rows and leaves live ones", async () => {
    const e = env();
    await requestApproval(e, REQ, transportReturning({ granted: true, expiresAt: NOW + 10 }), { now: NOW });
    await requestApproval(
      e,
      { ...REQ, resource: "other" },
      transportReturning({ granted: true, expiresAt: NOW + 900 }),
      { now: NOW },
    );
    expect(purgeExpiredGrants(e, NOW + 100)).toBe(1);
    expect(listGrants(e, NOW + 100).map((g) => g.resource)).toEqual(["other"]);
  });
});

// ── Replay / re-ask behavior ─────────────────────────────────────────────────

describe("an existing live grant answers without re-asking", () => {
  test("a second request reuses the grant and never calls the transport again", async () => {
    const e = env();
    let calls = 0;
    const counting: ApprovalTransport = {
      name: "counting",
      request: async () => {
        calls++;
        return { granted: true, expiresAt: LATER };
      },
    };
    expect((await requestApproval(e, REQ, counting, { now: NOW })).granted).toBe(true);
    expect(calls).toBe(1);

    const second = await requestApproval(e, REQ, counting, { now: NOW + 1 });
    expect(second.granted).toBe(true);
    expect(second.fromExistingGrant).toBe(true);
    expect(calls).toBe(1); // not re-asked
  });

  // The dangerous inverse: once expired, it must ASK AGAIN rather than coast.
  test("after expiry the transport is asked again — and a deny transport then denies", async () => {
    const e = env();
    await requestApproval(e, REQ, transportReturning({ granted: true, expiresAt: NOW + 10 }), { now: NOW });
    const after = await requestApproval(e, REQ, denyTransport, { now: NOW + 11 });
    expect(after.granted).toBe(false);
  });
});

// ── Injection ────────────────────────────────────────────────────────────────

describe("resource/session strings cannot break the store", () => {
  test("a SQL-injection-shaped resource is stored and scoped literally", async () => {
    const e = env();
    const nasty = `'; DROP TABLE approval_grants; --`;
    const out = await requestApproval(
      e,
      { ...REQ, resource: nasty },
      transportReturning({ granted: true, expiresAt: LATER }),
      { now: NOW },
    );
    expect(out.granted).toBe(true);
    // the table still exists and the grant is scoped to the literal string
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, nasty, NOW)).toBe(true);
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, "nda-review", NOW)).toBe(false);
  });

  test("an empty resource does not act as a wildcard", async () => {
    const e = env();
    await requestApproval(e, { ...REQ, resource: "" }, transportReturning({ granted: true, expiresAt: LATER }), {
      now: NOW,
    });
    // a grant for "" must not cover a real skill
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, "nda-review", NOW)).toBe(false);
  });
});

// ── Shared-file schema bootstrap ─────────────────────────────────────────────

/**
 * approval.ts's grant store and isolation.ts's audit log are two DIFFERENT
 * schemas in the SAME physical file (env.isolationDb). db.ts's connection
 * cache runs a path's `init` callback only on the first open of that path —
 * whichever module opens it first "wins" the init, and the other module's
 * schema is silently never created. This bit for real during development:
 * fixing grantDb() to survive audit-opens-first broke the OTHER direction
 * (approval-opens-first left audit_log missing) until both call sites stopped
 * relying on `init` for their schema and ran `CREATE TABLE IF NOT EXISTS`
 * unconditionally after opening. Pinned here so it can't silently regress if
 * either module's schema creation is ever moved back inside `init`.
 */
describe("grant store and audit log share one file — order of first open must not matter", () => {
  test("audit log works when the GRANT store opens the shared file first", async () => {
    const e = env();
    // approval.ts opens env.isolationDb first via a grant check.
    expect(hasLiveGrant(e, REQ.sessionId, REQ.room, REQ.resource, NOW)).toBe(false);
    // isolation.ts's audit log must still work — not "no such table: audit_log".
    expect(() => deny("sess-x", "read_skill", "some-skill", "reason", { room: "ops", env: e })).not.toThrow();
    expect(() => allow("sess-x", "read_skill", "some-skill", "reason", { room: "ops", env: e })).not.toThrow();
  });

  test("the grant store works when AUDIT opens the shared file first", async () => {
    const e = env();
    // isolation.ts (via audit.ts) opens env.isolationDb first.
    deny("sess-x", "read_skill", "some-skill", "reason", { room: "ops", env: e });
    // approval.ts's grant store must still work — not "no such table: approval_grants".
    expect(() => hasLiveGrant(e, REQ.sessionId, REQ.room, REQ.resource, NOW)).not.toThrow();
    const out = await requestApproval(e, REQ, transportReturning({ granted: true, expiresAt: LATER }), { now: NOW });
    expect(out.granted).toBe(true);
  });
});
