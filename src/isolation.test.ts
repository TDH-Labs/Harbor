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
