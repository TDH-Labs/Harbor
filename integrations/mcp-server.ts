/**
 * integrations/mcp-server.ts — Tier 1 universal MCP server (stdio, JSON-RPC 2.0).
 *
 * A persistent stdio MCP server (protocol revision {@link MCP_PROTOCOL_VERSION},
 * verified against the spec at build time — see PHASE5_NOTES.md) that exposes
 * Harbor's gated skill access to ANY MCP-capable agent (Claude Code, Cursor,
 * OpenCode, Codex, Gemini CLI, Goose) through one stdio entry. The protocol is
 * implemented directly — line-delimited JSON-RPC over stdin/stdout — so the
 * package takes no MCP SDK dependency and the single-binary `bun build --compile`
 * stays self-contained.
 *
 * Tools (room-gating + budget enforcement happen INSIDE the server, via Phase 3's
 * `gate()` / `checkBudget()` / `spendBudget()` — not in the agent):
 *   - route_skills(prompt)     Turn-Sieve: the 1-3 skills (5 if cross-domain) that
 *                              fit a task, from the session's room only
 *   - read_skill(skill_name)   load a skill's SKILL.md, gated + budgeted
 *   - list_skills(room?)       list pool skills for the session's room
 *   - list_rooms()             every configured room's name + description, no
 *                              skill content — unrestricted (room names aren't
 *                              sensitive; skill CONTENT still goes through
 *                              read_skill's normal room gate)
 *   - budget_status()          current session token budget (read-only)
 *   - audit_recent(limit?)     recent audit entries for the session's room
 *
 * Per-session gate context (the Phase 3 concurrency contract). EVERY request
 * handler runs inside {@link runWithGateContext} — the AsyncLocalStorage scope
 * from `gate.ts` — seeded from `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION`. The tools
 * read their session from `currentGateContext()` (the ALS store), never from a
 * shared module global, so concurrent requests for different sessions interleaved
 * in one process can NEVER read each other's room or budget. This is the exact
 * fail-open class that NO-GO'd Phase 3; `mcp-server.concurrency.test.ts` pins it.
 *
 * Honest enforcement (BUILD_BRIEF §6): routing skill loads through this server is
 * a boundary, not OS-level enforcement. An agent with raw filesystem access can
 * still read a SKILL.md directly. This server gates the MCP *tool path*; it does
 * not sandbox the process. Documented plainly, not over-claimed as "enforced".
 *
 * The server never crashes on a bad request: a malformed message, an unknown
 * method, or a throwing tool becomes a JSON-RPC error or an `isError` tool
 * result — the stdio loop keeps running.
 */
import {
  Capability,
  Environment,
  audit,
  checkBudget,
  currentGateContext,
  gate,
  runWithGateContext,
  spendBudget,
  estimateTokens,
  getSkill,
  getReflexionLessons,
  listSkills,
  searchSkills,
  AccessDeniedError,
  BudgetExceededError,
  type GateContext,
  createSession,
  normalizeRoomEnv,
  AgentSession,
  RoomJailViolation,
  routeTurn,
} from "harbor-tugboat";
import { agentFacingReason } from "../src/sensitivity.ts";
import pkg from "../package.json" with { type: "json" };

/** MCP protocol revision this server implements (verified at build time). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Server identity returned in the `initialize` handshake. `version` reads
 * package.json directly (same source `cli.ts`'s `--version` uses) rather than
 * a second hardcoded literal — two independent copies of the same value drift
 * the moment one gets bumped and the other doesn't, which is exactly what
 * happened here (this stayed "0.1.0" through the 0.1.1 release).
 */
export const SERVER_INFO = { name: "harbor", title: "Harbor", version: pkg.version } as const;

// ── JSON-RPC envelopes ───────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** Standard JSON-RPC error codes used by the server. */
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

/** An MCP tool result: a content array, optionally flagged as an error. */
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}
function errorResult(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

// ── Tool catalog ─────────────────────────────────────────────────────────────

/** The tools advertised by `tools/list` (MCP `inputSchema` is JSON Schema). */
export const TOOL_DEFINITIONS = [
  {
    name: "search_skills",
    description:
      "Search skills available to the current session's room by keyword/query with " +
      "relevance ranking. Returns lean summaries (<150 tokens) to avoid bloating context. " +
      "Use this to find what skill to activate for your task.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or task description (e.g. 'draft NDA' or 'git commit')." },
        room: { type: "string", description: "Optional room override (defaults to the session room)." },
        limit: { type: "number", description: "Max results to return (default 5, max 50)." },
      },
      required: ["query"],
    },
  },
  {
    name: "route_skills",
    description:
      "Pick the 1-3 skills (up to 5 when the task spans domains) from THIS room that best fit " +
      "the task you are about to do. Call it at the start of a task and whenever the topic " +
      "changes, then activate_skill what it names. Uses the System One router when reachable, " +
      "otherwise keyword matching; the answer says which. Returns names and one-line " +
      "descriptions only, so it costs a few dozen tokens instead of listing the whole room.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task or user request you are about to work on." },
        room: { type: "string", description: "Optional room override (defaults to the session room)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "activate_skill",
    description:
      "Activate a skill by name for sequential execution. Loads the skill's instructions " +
      "and sets it as the single active skill in the session. Complete the task using this " +
      "skill, then call deactivate_skill before switching to another skill.",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Slug of the skill to activate." },
      },
      required: ["skill_name"],
    },
  },
  {
    name: "deactivate_skill",
    description:
      "Deactivate the currently active skill, clearing active skill state and confirming " +
      "the session is ready to activate a new skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_skill",
    description:
      "Load a skill's full SKILL.md by name, gated by the session's room and token " +
      "budget. Use this instead of assuming skill content is already in context.",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Slug of the skill to load (see list_skills)." },
      },
      required: ["skill_name"],
    },
  },
  {
    name: "list_skills",
    description:
      "List the skills available to the current session's room, with one-line " +
      "descriptions. Call this to discover skills before loading one with read_skill.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Optional room override (defaults to the session room)." },
      },
    },
  },
  {
    name: "list_rooms",
    description:
      "List every configured room's name and one-line description — no skill " +
      "content, no room-scoping applied. Use this to discover what rooms exist " +
      "before delegating a task to a room-scoped sub-agent or connection; call " +
      "list_skills/read_skill against that room's own session for actual content.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "budget_status",
    description: "Report the current session's token budget (limit, used, remaining). Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "audit_recent",
    description: "Recent audit-log entries (denials and allowances) for the session's room.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries to return (default 10)." },
      },
    },
  },
] as const;

// ── Server ───────────────────────────────────────────────────────────────────

export interface McpServerOptions {
  /** Environment used by the default context resolver. Defaults to {@link Environment.default}. */
  env?: Environment;
  /**
   * Resolve the {@link GateContext} for a request. Production default reads
   * `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION` from `procEnv`. Injectable so the
   * concurrency test can multiplex distinct sessions through one server and
   * assert the AsyncLocalStorage scope keeps them isolated.
   */
  resolveContext?: (request: JsonRpcRequest) => GateContext;
  /** Process env to read AGENT_ENV_ROOM / AGENT_ENV_SESSION from (default `process.env`). */
  procEnv?: Record<string, string | undefined>;
  /**
   * Honor `[system_one] url` from the session's config (default true). Harbor
   * Server sets false: a tenant-editable URL would make the server issue
   * requests to arbitrary hosts. See {@link routeTurn}.
   */
  trustConfigSystemOneUrl?: boolean;
}

export interface McpServer {
  /** Handle one JSON-RPC message; returns the response, or null for a notification. */
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
}

/**
 * Build an MCP server. The returned {@link McpServer.handle} is reentrant and
 * safe to call concurrently: every request that touches a session is wrapped in
 * `runWithGateContext`, so two in-flight requests for different sessions never
 * cross context.
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const env = options.env ?? Environment.default();
  const procEnv = options.procEnv ?? process.env;
  const sessionCache = new Map<string, AgentSession>();
  const resolveContext =
    options.resolveContext ?? ((_req: JsonRpcRequest) => defaultContext(env, procEnv, sessionCache));

  // Tool functions read their session from the ambient gate context (ALS), so
  // they are gate()-wrapped once and resolve the session per async call chain.
  const readSkillGated = gate("read_skill", readSkillImpl);
  const listSkillsGated = gate("list_skills", listSkillsImpl);
  const searchSkillsGated = gate("search_skills", searchSkillsImpl);
  // Routing is a room-scoped search variant, so it rides the same capability.
  const routeSkillsGated = gate("search_skills", (prompt: string, room?: string) =>
    routeSkillsImpl(prompt, room, options.trustConfigSystemOneUrl ?? true),
  );
  const activateSkillGated = gate("activate_skill", activateSkillImpl);
  const deactivateSkillGated = gate("deactivate_skill", deactivateSkillImpl);

  async function dispatchTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case "search_skills": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return errorResult("search_skills: query is required.");
        const room = typeof args.room === "string" && args.room ? args.room : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 5;
        return searchSkillsGated(query, room, limit);
      }
      case "route_skills": {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) return errorResult("route_skills: prompt is required.");
        const room = typeof args.room === "string" && args.room ? args.room : undefined;
        return routeSkillsGated(prompt, room);
      }
      case "activate_skill": {
        const skill = typeof args.skill_name === "string" ? args.skill_name.trim() : "";
        if (!skill) return errorResult("activate_skill: skill_name is required.");
        return activateSkillGated(skill);
      }
      case "deactivate_skill":
        return deactivateSkillGated();
      case "read_skill": {
        const skill = typeof args.skill_name === "string" ? args.skill_name.trim() : "";
        if (!skill) return errorResult("read_skill: skill_name is required.");
        return readSkillGated(skill);
      }
      case "list_skills": {
        const room = typeof args.room === "string" && args.room ? args.room : undefined;
        return listSkillsGated(room);
      }
      case "list_rooms":
        return listRoomsImpl();
      case "budget_status":
        return budgetStatusImpl();
      case "audit_recent": {
        const limit = typeof args.limit === "number" ? args.limit : 10;
        return auditRecentImpl(limit);
      }
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  }

  async function handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // B2 — reject a non-object frame (null, array, scalar) before touching ANY
    // field. `JSON.parse("null")` is valid JSON that parses to null and slips past
    // the transport's parse try/catch; the old `request.id` deref then threw and
    // killed the read loop (a one-line DoS — every frame after it was dropped).
    // Per JSON-RPC an invalid request gets a -32600 with a null id; the loop
    // survives and processes the next frame.
    const frame = request as unknown;
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      return errorResponse(null, ERR_INVALID_REQUEST, "invalid request: expected a JSON-RPC object");
    }

    const id = request.id ?? null;
    const method = request.method;

    if (request.jsonrpc !== undefined && request.jsonrpc !== "2.0") {
      return errorResponse(id, ERR_INVALID_REQUEST, "jsonrpc must be '2.0'");
    }
    if (typeof method !== "string") {
      return errorResponse(id, ERR_INVALID_REQUEST, "missing method");
    }

    // A notification is a request with no `id`. Per JSON-RPC the server MUST NOT
    // reply to one — for ANY method, not just unknown ones. (The old code only
    // suppressed the reply in the default case, so a `ping`/`tools/list` sent as a
    // notification wrongly drew a response.)
    const isNotification = request.id === undefined || request.id === null;

    switch (method) {
      case "initialize":
        return isNotification
          ? null
          : ok(id, {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions:
                "This channel has curated skills for the work done here. BEFORE you start " +
                "a task, call route_skills with the task to get the few skills that fit " +
                "(or list_skills to see everything), and read_skill to load any " +
                "whose description fits — a matching skill's instructions are authoritative, so " +
                "prefer following one over improvising. Skills are gated by room and token " +
                "budget; denials and budget limits are enforced server-side and surfaced as " +
                "tool errors.",
            });

      case "notifications/initialized":
      case "initialized":
        return null; // client → server notification, no reply

      case "ping":
        return isNotification ? null : ok(id, {});

      case "tools/list":
        return isNotification ? null : ok(id, { tools: TOOL_DEFINITIONS });

      case "tools/call": {
        const params = request.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments as Record<string, unknown>) ?? {};
        if (!name)
          return isNotification ? null : errorResponse(id, ERR_INVALID_PARAMS, "tools/call: missing tool name");
        // Per-request gate context — the concurrency boundary. Resolving and
        // binding happen together so the whole tool chain (including its awaits)
        // carries this session's context and only this session's.
        let ctx: GateContext;
        try {
          ctx = resolveContext(request);
        } catch (err) {
          return isNotification
            ? null
            : errorResponse(id, ERR_INTERNAL, `context resolution failed: ${messageOf(err)}`);
        }
        // Run the tool for its side effects even as a notification, but per
        // JSON-RPC return no response when there is no id.
        const result = await runWithGateContext(ctx, () => safeDispatch(dispatchTool, name, args));
        return isNotification ? null : ok(id, result);
      }

      default:
        if (isNotification) return null;
        return errorResponse(id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  return { handle };
}

/**
 * Run a tool, converting any throw (AccessDenied, BudgetExceeded, or an
 * unexpected error) into an `isError` tool result. A tool MUST NOT crash the
 * server — the MCP contract is that tool failures are reported in-band.
 */
async function safeDispatch(
  dispatch: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await dispatch(name, args);
  } catch (err) {
    if (err instanceof AccessDeniedError) return errorResult(`access denied: ${err.message}`);
    // Already prefixed "HARBOR ROOM JAIL VIOLATION" — do not double-wrap it.
    if (err instanceof RoomJailViolation) return errorResult(err.message);
    if (err instanceof BudgetExceededError) return errorResult(`budget exceeded: ${err.message}`);
    return errorResult(`tool error: ${messageOf(err)}`);
  }
}

// ── Tool implementations (session resolved from the ambient gate context) ─────-

/** Search skills in the session's room by query. */
async function searchSkillsImpl(
  query: string,
  roomOverride?: string,
  limit: number = 5,
): Promise<ToolResult> {
  const { env, session } = currentGateContext();
  if (roomOverride && roomOverride !== session.room && !session.has(Capability.ADMIN)) {
    const reason = `room '${session.room}' may not search skills for room '${roomOverride}'`;
    audit.deny(session.sessionId, "search_skills", roomOverride, reason, { room: session.room, agentId: session.agentId, env });
    return errorResult(`access denied: ${reason}.`);
  }
  const room = roomOverride ?? session.room;
  const results = searchSkills(env, query, room, limit, (sk) => session.sensitivityAllowed(env, sk.name, room));
  if (results.length === 0) {
    return text(`No skills matched query '${query}' in room '${room}'.`);
  }
  const lines = [`Matching skills in room '${room}' (${results.length}):`, ""];
  for (const s of results) {
    lines.push(`- ${s.name}: ${s.description || "(see SKILL.md)"}`);
  }
  lines.push("", "To load a skill sequentially, call: activate_skill({ skill_name: '<name>' })");
  return text(lines.join("\n"));
}

/** Route a turn to the room's 1-3 most relevant skills (Turn-Sieve; see turn-sieve.ts). */
async function routeSkillsImpl(
  prompt: string,
  roomOverride: string | undefined,
  trustConfigUrl: boolean,
): Promise<ToolResult> {
  const r = await routeTurn(currentGateContext(), prompt, roomOverride, { trustConfigUrl });
  return r.ok ? text(r.text) : errorResult(r.text);
}

/**
 * Charge the caller's delivery quota for `tokens` of skill content. Returns the
 * refusal to send back INSTEAD of the content (audited as a denial), or null to
 * proceed. Harbor Core has no quota; Harbor Server sets one per person.
 */
function quotaRefusal(tool: string, skillName: string, tokens: number): ToolResult | null {
  const { env, session, quota } = currentGateContext();
  if (!quota) return null;
  const q = quota.charge(tokens);
  if (q.ok) return null;
  audit.deny(session.sessionId, tool, skillName, q.reason, { room: session.room, agentId: session.agentId, env });
  return errorResult(`quota exceeded: ${q.reason}`);
}

/** Activate a skill for sequential execution, debiting the budget and setting session activeSkill. */
async function activateSkillImpl(skillName: string): Promise<ToolResult> {
  const { env, session } = currentGateContext();
  const detail = getSkill(env, skillName);
  if (!detail || !detail.skillMd) {
    return errorResult(`skill '${skillName}' not found in the pool.`);
  }
  const tokens = estimateTokens(detail.content);
  const budgetOpts = { env, room: session.room, tokenLimit: env.config.roomBudget(session.room) };

  const check = checkBudget(session.sessionId, `skill:${skillName}`, tokens, budgetOpts);
  if (!check.ok) {
    audit.deny(session.sessionId, "activate_skill", skillName, check.reason ?? "budget exceeded", {
      room: session.room,
      agentId: session.agentId,
      env,
    });
    return errorResult(
      `budget exceeded activating '${skillName}': need ${tokens}, have ${check.remaining} ` +
        `(${check.used}/${check.limit} used).`,
    );
  }

  const refused = quotaRefusal("activate_skill", skillName, tokens);
  if (refused) return refused;

  spendBudget(session.sessionId, `skill:${skillName}`, tokens, budgetOpts);
  session.activeSkill = skillName;
  session.activeSkillStartedAt = Date.now() / 1000;
  audit.allow(session.sessionId, "activate_skill", skillName, `activated ${tokens} tokens`, {
    room: session.room,
    agentId: session.agentId,
    env,
  });

  const bannerParts = [
    `[HARBOR: SKILL '${skillName}' IS NOW ACTIVE]`,
    `Sequential policy: Focus exclusively on '${skillName}' until the task is complete.`,
  ];

  if (detail.recommendedTools && detail.recommendedTools.length > 0) {
    bannerParts.push(`Recommended tools for this skill: ${detail.recommendedTools.join(", ")}`);
  }

  try {
    const priorLessons = getReflexionLessons(env, session.room, skillName);
    if (priorLessons.length > 0) {
      bannerParts.push(`Prior Reflexion Lessons:`);
      for (const lesson of priorLessons) {
        bannerParts.push(`- [${lesson.failureCategory}] ${lesson.sanitizedRemedy}`);
      }
    }
  } catch {
    // Non-blocking: failure to read lessons never blocks skill activation
  }

  bannerParts.push(
    `When finished, call deactivate_skill to clear context before activating another skill.`,
    "---",
    "",
  );
  const banner = bannerParts.join("\n");
  return text(banner + detail.content);
}

/** Deactivate the currently active skill. */
async function deactivateSkillImpl(): Promise<ToolResult> {
  const { env, session } = currentGateContext();
  const previous = session.activeSkill;
  session.activeSkill = null;
  session.activeSkillStartedAt = null;
  audit.allow(session.sessionId, "deactivate_skill", previous ?? "none", "deactivated skill", {
    room: session.room,
    agentId: session.agentId,
    env,
  });
  return text(
    previous
      ? `Skill '${previous}' deactivated. Context is now clear. You may search and activate another skill.`
      : `No active skill was set. Context is ready for a new skill.`,
  );
}

/** Load a skill's content, debiting the session budget. Runs only if gate allows. */
async function readSkillImpl(skillName: string): Promise<ToolResult> {
  const { env, session } = currentGateContext();
  const detail = getSkill(env, skillName);
  if (!detail || !detail.skillMd) {
    return errorResult(`skill '${skillName}' not found in the pool.`);
  }
  const tokens = estimateTokens(detail.content);
  const budgetOpts = { env, room: session.room, tokenLimit: env.config.roomBudget(session.room) };

  const check = checkBudget(session.sessionId, `skill:${skillName}`, tokens, budgetOpts);
  if (!check.ok) {
    audit.deny(session.sessionId, "read_skill", skillName, check.reason ?? "budget exceeded", {
      room: session.room,
      agentId: session.agentId,
      env,
    });
    return errorResult(
      `budget exceeded loading '${skillName}': need ${tokens}, have ${check.remaining} ` +
        `(${check.used}/${check.limit} used).`,
    );
  }

  const refused = quotaRefusal("read_skill", skillName, tokens);
  if (refused) return refused;

  // Pre-check passed; debit. trySpend re-enforces the gate atomically.
  spendBudget(session.sessionId, `skill:${skillName}`, tokens, budgetOpts);
  audit.allow(session.sessionId, "read_skill", skillName, `loaded ${tokens} tokens`, {
    room: session.room,
    agentId: session.agentId,
    env,
  });
  return text(detail.content);
}

/** List the skills in the session's room (or an authorized room override). */
async function listSkillsImpl(roomOverride?: string): Promise<ToolResult> {
  const { env, session } = currentGateContext();
  // B1 — gate the room override. A caller-supplied room that differs from the
  // session's own is a cross-room enumeration; permit it only for an ADMIN
  // session. Otherwise deny (audited): a restricted session must not be able to
  // enumerate another room's skill list by passing room=<other>. Without this
  // guard `list_skills(room='legal')` from a marketing session leaks legal's pool.
  if (roomOverride && roomOverride !== session.room && !session.has(Capability.ADMIN)) {
    const reason = `room '${session.room}' may not list skills for room '${roomOverride}'`;
    audit.deny(session.sessionId, "list_skills", roomOverride, reason, { room: session.room, agentId: session.agentId, env });
    return errorResult(`access denied: ${reason}.`);
  }
  const room = roomOverride ?? session.room;
  const skills = session.filterVisible(env, listSkills(env, room), room);
  if (skills.length === 0) {
    return text(`No skills available in room '${room}'.`);
  }
  const lines = [`Skills in room '${room}' (${skills.length}):`, ""];
  for (const s of skills) {
    lines.push(`- ${s.name}: ${s.description || "(see SKILL.md)"}`);
  }
  lines.push("", "Load one with read_skill <skill_name>.");
  return text(lines.join("\n"));
}

/**
 * Every configured room's name and description — for a Core session. A Harbor Server
 * session sees only its own room: which other rooms exist in a tenant (and what they
 * are called) says who is working on what.
 */
function listRoomsImpl(): ToolResult {
  const { env, session } = currentGateContext();
  const rooms = Object.entries(env.config.roomSkills).filter(([room]) => !session.strictRoom || room === session.room);
  if (rooms.length === 0) return text("No rooms configured.");
  const lines = rooms.map(([room, data]) => `- ${room}: ${data.description || "(no description)"}`);
  return text(["Configured rooms:", "", ...lines].join("\n"));
}

/** Report the session's token budget without mutating it. */
function budgetStatusImpl(): ToolResult {
  const { env, session } = currentGateContext();
  const r = checkBudget(session.sessionId, "budget_status", 0, {
    env,
    room: session.room,
    tokenLimit: env.config.roomBudget(session.room),
  });
  return text(
    `Session ${session.sessionId} (room ${session.room}): ` +
      `${r.used}/${r.limit} tokens used, ${r.remaining} remaining.`,
  );
}

/**
 * Recent audit entries for the session's room.
 *
 * A session that has an identity (every Harbor Server session) is shown only the rows
 * of THIS SESSION — not its person's, because one person can hold several credentials
 * at once (a capped bring-your-own token and a house agent acting for them), and what
 * the uncapped one loaded must not be readable by the capped one. It also needs the
 * `audit_read` capability, which no room holds by default, so the operator can leave
 * it off entirely. A session with no identity (Harbor Core, one operator) keeps the
 * room-wide view. Sensitivity denials are shown in the words the agent was given at
 * the time, and `limit` is bounded.
 */
function auditRecentImpl(limit: number): ToolResult {
  const { env, session } = currentGateContext();
  if (session.strictRoom && !session.has(Capability.AUDIT_READ)) {
    const reason = `session lacks capability '${Capability.AUDIT_READ}'`;
    audit.deny(session.sessionId, "audit_recent", "", reason, { room: session.room, agentId: session.agentId, env });
    return errorResult(`access denied: ${reason}.`);
  }
  const n = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 10)));
  const entries = audit.recent({
    env,
    room: session.room,
    ...(session.agentId ? { sessionId: session.sessionId } : {}),
    limit: n,
  });
  if (entries.length === 0) return text(`No audit entries for room '${session.room}'.`);
  const lines = entries.map((e) => {
    const reason = agentFacingReason(e.reason, session.room);
    return `${e.decision.padEnd(7)} ${e.capability || e.event} ${e.resource}${reason ? ` — ${reason}` : ""}`;
  });
  return text(lines.join("\n"));
}

// ── Context resolution ───────────────────────────────────────────────────────

/**
 * Default per-request context: a session keyed by `AGENT_ENV_ROOM` /
 * `AGENT_ENV_SESSION`, with room-resolved capabilities. Mirrors the env-var
 * fallback in `gate.currentGateContext`, but reads from the supplied `procEnv`
 * so it is testable without touching the live process environment.
 */
function defaultContext(
  env: Environment,
  procEnv: Record<string, string | undefined>,
  cache?: Map<string, AgentSession>,
): GateContext {
  // `??` alone is not enough: a blank value (Gemini CLI substitutes an empty
  // string for an unset variable) or an unsubstituted "${AGENT_ENV_ROOM}"
  // literal (Goose/OpenCode/Claude Code-when-unset) is not null, so it slipped
  // past the fallback and became the session's room. See normalizeRoomEnv.
  const room = normalizeRoomEnv(procEnv.AGENT_ENV_ROOM) ?? env.config.skillDefaultRoom;
  const sessionId = procEnv.AGENT_ENV_SESSION ?? "";
  const memoKey = `${room}:${sessionId}`;
  let session = cache?.get(memoKey);
  if (!session) {
    session = createSession({
      room,
      capabilities: env.config.roomCapabilities(room),
      ...(sessionId ? { sessionId } : {}),
    });
    cache?.set(memoKey, session);
  }
  return { env, session };
}

// ── stdio transport ──────────────────────────────────────────────────────────

/**
 * Run the server over a line-delimited JSON-RPC stream. Reads requests from
 * `input` (one JSON object per line), writes responses to `output`. Returns when
 * the input stream ends. Each request is dispatched as it arrives; a parse error
 * yields a JSON-RPC parse error rather than killing the loop.
 */
export async function runStdioServer(
  server: McpServer,
  input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
  write: (line: string) => void = (line) => process.stdout.write(line),
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  const emit = async (request: JsonRpcRequest): Promise<void> => {
    const response = await server.handle(request);
    if (response !== null) write(JSON.stringify(response) + "\n");
  };

  const processLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write(JSON.stringify(errorResponse(null, ERR_PARSE, "parse error")) + "\n");
      return;
    }
    await emit(request);
  };

  for await (const chunk of input as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await processLine(line);
    }
  }
  if (buffer.trim()) await processLine(buffer);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
