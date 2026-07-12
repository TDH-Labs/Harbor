/**
 * mcp-server.test.ts — MCP stdio server tool + protocol tests.
 *
 * Soak-safe (BUILD_BRIEF §7): every test threads an explicit Environment rooted
 * in a fresh mkdtemp dir and a procEnv object — no test reads the live machine's
 * $HOME, ~/.agent-env, or process env. All skill files are written under the
 * temp root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "../src/config.ts";
import { closeAllDbs } from "../src/db.ts";
import { Environment } from "../src/env.ts";
import { auditRead } from "../src/isolation.ts";
import {
  MCP_PROTOCOL_VERSION,
  TOOL_DEFINITIONS,
  createMcpServer,
  runStdioServer,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./mcp-server.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-mcp-server-"));
});
afterEach(() => {
  closeAllDbs();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build an Environment with a skill pool on disk. `rooms` configures room → skill
 * allowlist + budget; `skills` are written into the pool (flat layout).
 */
function makeEnv(opts: {
  rooms?: Record<string, unknown>;
  skills?: Record<string, string>;
}): Environment {
  const stateDir = join(dir, ".agent-env");
  const skillsDir = join(dir, ".agents", "skills");
  const cfg = new Config(
    deepMerge(DEFAULTS, {
      paths: { state_dir: stateDir, skills_dir: skillsDir },
      skills: { rooms: opts.rooms ?? {}, default_room: "general" },
    }),
  );
  const env = new Environment(dir, cfg);
  for (const [name, body] of Object.entries(opts.skills ?? {})) {
    const sdir = join(skillsDir, name);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "SKILL.md"), body);
  }
  return env;
}

function skillMd(name: string, description: string, body = "Step 1. Do the thing."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

const READ_CAPS = ["read_skill", "list_skills"];

/** A server whose context always resolves to the given room/session. */
function serverFor(env: Environment, room: string, sessionId: string) {
  return createMcpServer({ env, procEnv: { AGENT_ENV_ROOM: room, AGENT_ENV_SESSION: sessionId } });
}

async function call(
  server: { handle: (r: JsonRpcRequest) => Promise<JsonRpcResponse | null> },
  name: string,
  args: Record<string, unknown> = {},
  id: number = 1,
): Promise<JsonRpcResponse> {
  const res = await server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  if (!res) throw new Error("expected a response");
  return res;
}

function toolText(res: JsonRpcResponse): string {
  const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
  return result.content.map((c) => c.text).join("\n");
}
function isError(res: JsonRpcResponse): boolean {
  return Boolean((res.result as { isError?: boolean }).isError);
}

// ── Protocol handshake ─────────────────────────────────────────────────────--

describe("MCP protocol", () => {
  test("initialize returns the pinned protocol version + server info", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const result = res!.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe("harbor");
    expect(result.capabilities).toHaveProperty("tools");
  });

  test("notifications/initialized yields no response", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    const res = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
  });

  test("tools/list advertises the five tools with input schemas", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    const res = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const result = res!.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["audit_recent", "budget_status", "list_rooms", "list_skills", "read_skill"]);
    for (const t of result.tools) expect(t.inputSchema).toHaveProperty("type", "object");
    expect(result.tools.length).toBe(TOOL_DEFINITIONS.length);
  });

  test("unknown method → JSON-RPC method-not-found error (server does not crash)", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    const res = await server.handle({ jsonrpc: "2.0", id: 9, method: "no/such/method" });
    expect(res!.error?.code).toBe(-32601);
  });

  test("bad jsonrpc version is rejected as invalid request", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    const res = await server.handle({ jsonrpc: "1.0", id: 3, method: "tools/list" });
    expect(res!.error?.code).toBe(-32600);
  });

  test("ping replies with an empty result", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    const res = await server.handle({ jsonrpc: "2.0", id: 4, method: "ping" });
    expect(res!.result).toEqual({});
  });

  // Item 3 — a known method sent WITHOUT an id is a notification; per JSON-RPC it
  // must not draw a response. The bug suppressed replies only for unknown methods.
  test("a known method as a notification (no id) gets no response", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    expect(await server.handle({ jsonrpc: "2.0", method: "ping" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", method: "tools/list" })).toBeNull();
  });

  // B2 (direct) — a non-object frame is an invalid request, never a crash.
  test("a null frame is an invalid-request error, not a thrown deref", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    const res = await server.handle(null as unknown as JsonRpcRequest);
    expect(res!.error?.code).toBe(-32600);
    expect(res!.id).toBeNull();
  });
});

// ── read_skill gating ──────────────────────────────────────────────────────--

describe("read_skill", () => {
  test("returns skill content for an allowed room", async () => {
    const env = makeEnv({
      rooms: { legal: { skills: ["nda-review"], capabilities: READ_CAPS, budget: 100000 } },
      skills: { "nda-review": skillMd("nda-review", "Review an NDA", "Check the indemnity clause.") },
    });
    const server = serverFor(env, "legal", "sess-legal");
    const res = await call(server, "read_skill", { skill_name: "nda-review" });
    expect(isError(res)).toBe(false);
    expect(toolText(res)).toContain("indemnity clause");
  });

  test("denies a skill that is not in the session's room", async () => {
    const env = makeEnv({
      rooms: {
        legal: { skills: ["nda-review"], capabilities: READ_CAPS, budget: 100000 },
        marketing: { skills: ["campaign"], capabilities: READ_CAPS, budget: 100000 },
      },
      skills: {
        "nda-review": skillMd("nda-review", "Review an NDA"),
        campaign: skillMd("campaign", "Plan a campaign"),
      },
    });
    const server = serverFor(env, "marketing", "sess-mkt");
    const res = await call(server, "read_skill", { skill_name: "nda-review" });
    expect(isError(res)).toBe(true);
    expect(toolText(res).toLowerCase()).toContain("denied");
    // The denial is persisted to the audit log.
    const denials = auditRead(env, { room: "marketing" }).filter((e) => e.decision === "denied");
    expect(denials.some((e) => e.resource === "nda-review")).toBe(true);
  });

  test("denies when the room lacks the read_skill capability", async () => {
    const env = makeEnv({
      rooms: { readonly: { skills: ["doc"], capabilities: ["list_skills"], budget: 100000 } },
      skills: { doc: skillMd("doc", "A doc") },
    });
    const server = serverFor(env, "readonly", "sess-ro");
    const res = await call(server, "read_skill", { skill_name: "doc" });
    expect(isError(res)).toBe(true);
    expect(toolText(res).toLowerCase()).toContain("denied");
  });

  test("missing skill_name is a tool error, not a crash", async () => {
    const env = makeEnv({ rooms: { general: { skills: [], capabilities: READ_CAPS } } });
    const server = serverFor(env, "general", "s1");
    const res = await call(server, "read_skill", {});
    expect(isError(res)).toBe(true);
    expect(toolText(res)).toContain("skill_name is required");
  });

  test("unknown skill name reports not found", async () => {
    const env = makeEnv({ rooms: { general: { skills: [], capabilities: READ_CAPS } } });
    const server = serverFor(env, "general", "s1");
    const res = await call(server, "read_skill", { skill_name: "does-not-exist" });
    expect(isError(res)).toBe(true);
    expect(toolText(res)).toContain("not found");
  });

  test("debits the session budget and denies once exhausted", async () => {
    const big = "x".repeat(4000); // ~1000 tokens (chars/4)
    const env = makeEnv({
      rooms: { tiny: { skills: ["a", "b"], capabilities: READ_CAPS, budget: 1200 } },
      skills: { a: skillMd("a", "skill a", big), b: skillMd("b", "skill b", big) },
    });
    const server = serverFor(env, "tiny", "sess-tiny");
    const first = await call(server, "read_skill", { skill_name: "a" });
    expect(isError(first)).toBe(false);
    // Second load pushes past the 1200-token budget → budget-exceeded tool error.
    const second = await call(server, "read_skill", { skill_name: "b" });
    expect(isError(second)).toBe(true);
    expect(toolText(second).toLowerCase()).toContain("budget");
  });
});

// ── list_skills / budget_status / audit_recent ─────────────────────────────--

describe("list_skills", () => {
  test("lists the skills in the session's room", async () => {
    const env = makeEnv({
      rooms: { legal: { skills: ["nda-review", "case-brief"], capabilities: READ_CAPS } },
      skills: {
        "nda-review": skillMd("nda-review", "Review an NDA"),
        "case-brief": skillMd("case-brief", "Brief a case"),
      },
    });
    const server = serverFor(env, "legal", "s1");
    const res = await call(server, "list_skills");
    const txt = toolText(res);
    expect(txt).toContain("nda-review");
    expect(txt).toContain("case-brief");
    expect(txt).toContain("Review an NDA");
  });

  // B1 — a restricted session must not enumerate another room's skills, whether by
  // the default scope (no override) or by passing room=<other>. Two-room pool with
  // DISTINCT skills so "list everything" and "list the other room" are both
  // detectable. Seeding the marketing session in a room that owns `campaign` only.
  test("does not reveal another room's skills (default scope or explicit override)", async () => {
    const env = makeEnv({
      rooms: {
        marketing: { skills: ["campaign"], capabilities: READ_CAPS, budget: 100000 },
        legal: { skills: ["nda-review", "case-brief"], capabilities: READ_CAPS, budget: 100000 },
      },
      skills: {
        campaign: skillMd("campaign", "Plan a campaign"),
        "nda-review": skillMd("nda-review", "Review an NDA"),
        "case-brief": skillMd("case-brief", "Brief a case"),
      },
    });
    const server = serverFor(env, "marketing", "sess-mkt");

    // Default scope sees only marketing's own skill, never legal's.
    const own = await call(server, "list_skills");
    expect(toolText(own)).toContain("campaign");
    expect(toolText(own)).not.toContain("nda-review");
    expect(toolText(own)).not.toContain("case-brief");

    // The cross-room override is denied — legal's pool stays hidden.
    const cross = await call(server, "list_skills", { room: "legal" });
    expect(isError(cross)).toBe(true);
    expect(toolText(cross).toLowerCase()).toContain("denied");
    expect(toolText(cross)).not.toContain("nda-review");
    expect(toolText(cross)).not.toContain("case-brief");

    // The denial is persisted to the audit log under the caller's room.
    const denials = auditRead(env, { room: "marketing" }).filter((e) => e.decision === "denied");
    expect(denials.some((e) => e.capability === "list_skills" && e.resource === "legal")).toBe(true);
  });
});

describe("list_rooms", () => {
  test("lists every configured room's name and description", async () => {
    const env = makeEnv({
      rooms: {
        legal: { description: "Legal work", skills: [], capabilities: READ_CAPS },
        devops: { description: "Infra and CI", skills: [], capabilities: READ_CAPS },
      },
    });
    const server = serverFor(env, "legal", "s1");
    const txt = toolText(await call(server, "list_rooms"));
    expect(txt).toContain("legal: Legal work");
    expect(txt).toContain("devops: Infra and CI");
  });

  // Deliberately unrestricted, unlike list_skills — a marketing session must
  // still see EVERY room's name/description, since room metadata isn't
  // sensitive (skill CONTENT within a room stays gated by list_skills/
  // read_skill's normal room check). This is the intended design, not a gap:
  // it's what lets an orchestrator discover which room to delegate a task to
  // without needing ADMIN just to see the room list.
  test("a non-admin session sees every room, not just its own (by design)", async () => {
    const env = makeEnv({
      rooms: {
        marketing: { description: "Marketing", skills: ["campaign"], capabilities: READ_CAPS },
        legal: { description: "Legal work", skills: ["nda-review"], capabilities: READ_CAPS },
      },
    });
    const server = serverFor(env, "marketing", "sess-mkt");
    const txt = toolText(await call(server, "list_rooms"));
    expect(txt).toContain("marketing: Marketing");
    expect(txt).toContain("legal: Legal work");
  });

  test("reports no skill content, only names and descriptions", async () => {
    const env = makeEnv({
      rooms: { legal: { description: "Legal work", skills: ["nda-review"], capabilities: READ_CAPS } },
      skills: { "nda-review": skillMd("nda-review", "Review an NDA", "SECRET_STEP_CONTENT") },
    });
    const server = serverFor(env, "legal", "s1");
    const txt = toolText(await call(server, "list_rooms"));
    expect(txt).not.toContain("nda-review");
    expect(txt).not.toContain("SECRET_STEP_CONTENT");
  });

  test("reports a clean message when no rooms are configured", async () => {
    const server = serverFor(makeEnv({}), "general", "s1");
    const txt = toolText(await call(server, "list_rooms"));
    expect(txt).toContain("No rooms configured");
  });
});

describe("budget_status", () => {
  test("reports the room budget and spent tokens", async () => {
    const env = makeEnv({
      rooms: { legal: { skills: ["nda-review"], capabilities: READ_CAPS, budget: 50000 } },
      skills: { "nda-review": skillMd("nda-review", "Review an NDA", "y".repeat(400)) },
    });
    const server = serverFor(env, "legal", "sess-b");
    const before = await call(server, "budget_status");
    expect(toolText(before)).toContain("0/50000");
    await call(server, "read_skill", { skill_name: "nda-review" });
    const after = await call(server, "budget_status");
    expect(toolText(after)).not.toContain("0/50000");
    expect(toolText(after)).toContain("/50000");
  });
});

describe("audit_recent", () => {
  test("surfaces a prior denial for the room", async () => {
    const env = makeEnv({
      rooms: {
        legal: { skills: ["nda-review"], capabilities: READ_CAPS, budget: 100000 },
        marketing: { skills: ["campaign"], capabilities: READ_CAPS, budget: 100000 },
      },
      skills: {
        "nda-review": skillMd("nda-review", "Review an NDA"),
        campaign: skillMd("campaign", "Plan a campaign"),
      },
    });
    const server = serverFor(env, "marketing", "sess-mkt");
    await call(server, "read_skill", { skill_name: "nda-review" }); // denied → audited
    const res = await call(server, "audit_recent", { limit: 5 });
    expect(toolText(res).toLowerCase()).toContain("denied");
  });
});

// ── stdio transport ────────────────────────────────────────────────────────--

describe("runStdioServer", () => {
  test("line-delimited JSON-RPC over a stream returns the tool list", async () => {
    const env = makeEnv({ rooms: { general: { skills: [], capabilities: READ_CAPS } } });
    const server = serverFor(env, "general", "s1");
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'));
        controller.close();
      },
    });
    const out: string[] = [];
    await runStdioServer(server, input, (line) => out.push(line));
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!) as JsonRpcResponse;
    const result = parsed.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toContain("read_skill");
  });

  test("a malformed line yields a parse error and the loop continues", async () => {
    const env = makeEnv({ rooms: { general: { skills: [], capabilities: READ_CAPS } } });
    const server = serverFor(env, "general", "s1");
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not json\n"));
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":2,"method":"ping"}\n'));
        controller.close();
      },
    });
    const out: string[] = [];
    await runStdioServer(server, input, (line) => out.push(line));
    expect(out.length).toBe(2);
    expect((JSON.parse(out[0]!) as JsonRpcResponse).error?.code).toBe(-32700);
    expect((JSON.parse(out[1]!) as JsonRpcResponse).result).toEqual({});
  });

  // B2 — `null\n` is valid JSON that parses to `null`, so it slips past the parse
  // guard. The old handler dereferenced `request.id` on it and threw, killing the
  // read loop so every later frame was dropped. The loop must survive: the null
  // frame draws an invalid-request error and the following `ping` still responds.
  test("a null frame is rejected without killing the loop; the next request still responds", async () => {
    const env = makeEnv({ rooms: { general: { skills: [], capabilities: READ_CAPS } } });
    const server = serverFor(env, "general", "s1");
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("null\n"));
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":7,"method":"ping"}\n'));
        controller.close();
      },
    });
    const out: string[] = [];
    await runStdioServer(server, input, (line) => out.push(line));
    expect(out.length).toBe(2);
    expect((JSON.parse(out[0]!) as JsonRpcResponse).error?.code).toBe(-32600);
    expect((JSON.parse(out[1]!) as JsonRpcResponse).result).toEqual({});
  });
});
