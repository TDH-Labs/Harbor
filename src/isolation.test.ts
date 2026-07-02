import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import {
  AccessDenied,
  AgentSession,
  auditDenialsToday,
  auditLog,
  auditRead,
  Capability,
  checkDataAccess,
  checkFileAccess,
  checkMcpAccess,
  checkSkillAccess,
  createSession,
  requireCapability,
} from "./isolation.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-iso-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envWithRooms(rooms: Record<string, unknown>): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { skills: { rooms } }));
  return new Environment(dir, cfg);
}

describe("createSession capabilities", () => {
  test("no config ⇒ deny-by-default baseline", () => {
    const s = createSession({ room: "legal" });
    expect(s.has(Capability.READ_SKILL)).toBe(true);
    expect(s.has(Capability.LIST_SKILLS)).toBe(true);
    expect(s.has(Capability.SCHEDULE)).toBe(false);
    expect(s.has(Capability.ADMIN)).toBe(false);
  });

  test("capabilities come from config when present", () => {
    const env = envWithRooms({
      ops: { skills: [], capabilities: ["read_skill", "schedule", "admin"] },
    });
    const s = createSession({ room: "ops", env });
    expect(s.has(Capability.SCHEDULE)).toBe(true);
    expect(s.has(Capability.ADMIN)).toBe(true);
    expect(s.has(Capability.MCP_MERGE)).toBe(false);
  });

  test("id aliases sessionId and ids are distinct under a fixed clock", () => {
    const a = createSession({ room: "r", createdAt: 100 });
    const b = createSession({ room: "r", createdAt: 100 });
    expect(a.id).toBe(a.sessionId);
    expect(a.id).not.toBe(b.id);
  });
});

describe("capability checks", () => {
  test("check throws AccessDenied for an unheld capability", () => {
    const s = new AgentSession({ room: "legal", capabilities: ["read_skill"] });
    expect(() => s.check(Capability.SCHEDULE)).toThrow(AccessDenied);
    expect(() => s.check(Capability.READ_SKILL)).not.toThrow();
  });

  test("a denial is written to the audit trail when env is supplied", () => {
    const env = envWithRooms({});
    const s = new AgentSession({ room: "legal", capabilities: ["read_skill"] });
    expect(() => s.check(Capability.SCHEDULE, "task:x", env)).toThrow(AccessDenied);
    const denials = auditRead(env, { room: "legal" });
    expect(denials.length).toBe(1);
    expect(denials[0]?.decision).toBe("denied");
    expect(denials[0]?.capability).toBe("schedule");
  });

  test("requireCapability gates a wrapped tool function", () => {
    const tool = requireCapability(Capability.READ_SKILL, (_s: AgentSession, name: string) => `loaded:${name}`);
    const ok = new AgentSession({ room: "r", capabilities: ["read_skill"] });
    expect(tool(ok, "nda")).toBe("loaded:nda");
    const no = new AgentSession({ room: "r", capabilities: ["list_skills"] });
    expect(() => tool(no, "nda")).toThrow(AccessDenied);
  });
});

describe("room-gated resource access", () => {
  test("checkSkillAccess requires capability and room membership", () => {
    const env = envWithRooms({
      legal: { skills: ["nda-review"], capabilities: ["read_skill", "list_skills"] },
    });
    const legal = createSession({ room: "legal", env });
    expect(checkSkillAccess(legal, env, "nda-review")).toBe(true);
    expect(checkSkillAccess(legal, env, "tax-model")).toBe(false); // not in room
  });

  test("an empty room allowlist imposes no skill restriction", () => {
    const env = envWithRooms({ open: { skills: [] } });
    const s = createSession({ room: "open", env });
    expect(checkSkillAccess(s, env, "anything")).toBe(true);
  });

  test("checkSkillAccess fails without the read_skill capability", () => {
    const env = envWithRooms({ legal: { skills: ["nda-review"], capabilities: ["list_skills"] } });
    const s = createSession({ room: "legal", env });
    expect(checkSkillAccess(s, env, "nda-review")).toBe(false);
  });

  test("checkMcpAccess requires capability and room ownership", () => {
    const env = envWithRooms({
      legal: {
        skills: [],
        capabilities: ["read_skill", "mcp_access"],
        mcp: { servers: [{ name: "nda-fs" }] },
      },
    });
    const s = createSession({ room: "legal", env });
    expect(checkMcpAccess(s, env, "nda-fs")).toBe(true);
    expect(checkMcpAccess(s, env, "other")).toBe(false);
  });
});

describe("data/file gating with ADMIN bypass", () => {
  test("data access is confined to data/<room>/ unless ADMIN", () => {
    const env = envWithRooms({});
    const reader = new AgentSession({ room: "legal", capabilities: ["data_read"] });
    expect(checkDataAccess(reader, join(dir, "data/legal/cases.db"), env)).toBe(true);
    expect(checkDataAccess(reader, join(dir, "data/finance/books.db"), env)).toBe(false);

    const admin = new AgentSession({ room: "legal", capabilities: ["data_read", "admin"] });
    expect(checkDataAccess(admin, join(dir, "data/finance/books.db"), env)).toBe(true);
  });

  test("file access is confined to workspace/<room>/ and respects mode", () => {
    const env = envWithRooms({});
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    expect(checkFileAccess(s, join(dir, "workspace/legal/draft.md"), "read", env)).toBe(true);
    expect(checkFileAccess(s, join(dir, "workspace/legal/draft.md"), "write", env)).toBe(false); // no file_write
    expect(checkFileAccess(s, join(dir, "workspace/marketing/x.md"), "read", env)).toBe(false);
  });

  // Regression for the REVIEW_06.md NO-GO finding: an unnormalized `..` segment
  // must not let a path-string prefix check pass while the path actually
  // resolves outside the room. Both an absolute-with-`..` and a bare relative
  // `..`-bearing input are covered — either shape used to slip past the old
  // plain `startsWith`/`slice` check.
  test("file access denies a `..`-escaping path even though it string-prefixes the allowed room", () => {
    const env = envWithRooms({});
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    const escaping = join(dir, "workspace/legal/../finance/secret.md");
    expect(checkFileAccess(s, escaping, "read", env)).toBe(false);
    // sanity: the same file, addressed directly, resolves to the same denial
    expect(checkFileAccess(s, join(dir, "workspace/finance/secret.md"), "read", env)).toBe(false);
  });

  test("file access denies a bare relative `..`-escaping path", () => {
    const env = envWithRooms({});
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    expect(checkFileAccess(s, "workspace/legal/../finance/secret.md", "read", env)).toBe(false);
  });

  test("data access denies a `..`-escaping db path", () => {
    const env = envWithRooms({});
    const reader = new AgentSession({ room: "legal", capabilities: ["data_read"] });
    const escaping = join(dir, "data/legal/../finance/books.db");
    expect(checkDataAccess(reader, escaping, env)).toBe(false);
  });

  // Regression for a fail-open the `..`-traversal fix itself introduced:
  // join(base, "workspace"/"data", "") collapses to the SHARED parent
  // (`${base}/workspace`), which contains every room, so an unrooted
  // session was granted access to ALL rooms — the exact opposite of the old
  // string-prefix check, which matched no real path for room="" and denied
  // everything. An unrooted session must be denied, never treated as
  // "every room."
  test("file access denies a session with an empty room, across every room", () => {
    const env = envWithRooms({});
    const s = new AgentSession({ room: "", capabilities: ["file_read"] });
    expect(checkFileAccess(s, join(dir, "workspace/legal/draft.md"), "read", env)).toBe(false);
    expect(checkFileAccess(s, join(dir, "workspace/finance/books.md"), "read", env)).toBe(false);
    expect(checkFileAccess(s, join(dir, "workspace/marketing/x.md"), "read", env)).toBe(false);
  });

  test("data access denies a session with an empty room, across every room", () => {
    const env = envWithRooms({});
    const reader = new AgentSession({ room: "", capabilities: ["data_read"] });
    expect(checkDataAccess(reader, join(dir, "data/legal/cases.db"), env)).toBe(false);
    expect(checkDataAccess(reader, join(dir, "data/finance/books.db"), env)).toBe(false);
  });

  // ADMIN is the one intended bypass — the empty-room guard must sit AFTER
  // the ADMIN check, not before it, or an admin session with no particular
  // room (a plausible system/bootstrap session shape) would be wrongly
  // denied instead of granted its explicit escalation.
  test("ADMIN with an empty room still bypasses room-scoping (guard ordering)", () => {
    const env = envWithRooms({});
    const admin = new AgentSession({ room: "", capabilities: ["file_read", "data_read", "admin"] });
    expect(checkFileAccess(admin, join(dir, "workspace/finance/secret.md"), "read", env)).toBe(true);
    expect(checkDataAccess(admin, join(dir, "data/finance/books.db"), env)).toBe(true);
  });
});

describe("audit log", () => {
  test("counts today's denials and filters by room", () => {
    const env = envWithRooms({});
    const legal = new AgentSession({ room: "legal" });
    const mkt = new AgentSession({ room: "marketing" });
    auditLog(env, legal, { event: "x", decision: "denied", capability: "schedule" });
    auditLog(env, legal, { event: "y", decision: "allowed", capability: "read_skill" });
    auditLog(env, mkt, { event: "z", decision: "denied", capability: "mcp_access" });

    expect(auditDenialsToday(env)).toBe(2);
    expect(auditDenialsToday(env, "legal")).toBe(1);
  });

  test("createSession logs an allowed session_created event", () => {
    const env = envWithRooms({});
    createSession({ room: "legal", env });
    const entries = auditRead(env, { room: "legal" });
    expect(entries.some((e) => e.event === "session_created" && e.decision === "allowed")).toBe(true);
  });
});
