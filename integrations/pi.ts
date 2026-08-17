/**
 * integrations/pi.ts — Tier 2 in-process integration for Pi (and any TS/JS agent
 * with import-level extension hooks).
 *
 * Replaces the execSync-bridged `~/.pi/agent/extensions/skill-accessor.ts` with a
 * DIRECT in-process import: enforcement is a function call, not a subprocess.
 *
 *   import { gate, checkBudget, spendBudget, audit } from 'harbor-tugboat';
 *
 * The budget check, room gate, and audit write are <3ms synchronous SQLite calls
 * — no shell, no Python, no CLI parsing. Same two tools as the old extension —
 * `read_skill`, `list_skills` — with identical room-gating + budget semantics, now
 * enforced by Phase 3's hypervisor primitives.
 *
 * Per-session context: every tool execution runs inside `runWithGateContext`
 * (the AsyncLocalStorage scope), seeded from `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION`
 * — the same vars `spawn()` injects. A host that runs one Pi process per session
 * gets correct isolation from the env vars; a host that multiplexes sessions binds
 * each explicitly. Concurrent chains never cross context (see
 * `mcp-server.concurrency.test.ts` — the same gate primitive backs both tiers).
 *
 * Honest enforcement (BUILD_BRIEF §6): this gates the *tool path*. An agent with
 * raw filesystem access can still read a SKILL.md directly — this is cooperative,
 * tool-level enforcement, not an OS sandbox. Not over-claimed as "enforced".
 *
 * Dependency note: this module types the Pi extension API STRUCTURALLY (see
 * {@link PiExtensionApi}) rather than importing `@earendil-works/pi-coding-agent`,
 * so Harbor stays dependency-free and the de-personalization scan has nothing
 * machine-specific to flag. The emitted tool `parameters` are plain JSON Schema,
 * which Pi/TypeBox accept at runtime.
 */
// IMPORTANT: import from NARROW submodules, NOT the "harbor-tugboat" barrel.
// The barrel (src/index.ts) re-exports dashboard.ts (Hono + Bun.serve) which pulls in
// hono/dist/adapter/bun/ssg.js — a module that references the global `Bun` at evaluation
// time and CRASHES under Node pi ("Bun is not defined"). These narrow modules do not
// transitively import dashboard/cli/spawn/mcp/bench, so the pi extension loads cleanly.
import { gate, runWithGateContext, currentGateContext, AccessDeniedError, type GateContext } from "harbor-tugboat/gate";
import { checkBudget, spendBudget, BudgetExceededError } from "harbor-tugboat/budget";
import { getSkill, listSkills, searchSkills } from "harbor-tugboat/skills";
import { Environment } from "harbor-tugboat/env";
import { normalizeRoomEnv } from "harbor-tugboat/config";
import { Capability, AgentSession } from "harbor-tugboat/isolation";
import { estimateTokens } from "harbor-tugboat/compaction";
import { audit } from "harbor-tugboat/audit";

// ── Pi extension API (structural — no package dependency) ─────────────────────

/** One content block in a Pi tool result. */
export interface PiContent {
  type: "text";
  text: string;
}

/** A Pi tool result: content blocks plus opaque structured details. */
export interface PiToolResult {
  content: PiContent[];
  details?: Record<string, unknown>;
}

/** The subset of Pi's tool-registration API this integration uses. */
export interface PiToolDefinition {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  /** JSON Schema for the tool arguments (TypeBox schemas are JSON Schema at runtime). */
  parameters: unknown;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<PiToolResult>;
}

/** The structural shape of Pi's `ExtensionAPI` (only `registerTool` is needed). */
export interface PiExtensionApi {
  registerTool(tool: PiToolDefinition): void;
}

// ── Context resolution ───────────────────────────────────────────────────────

export interface PiHarborOptions {
  /** Harbor environment. Defaults to {@link Environment.default}. */
  env?: Environment;
  /** Process env to read AGENT_ENV_ROOM / AGENT_ENV_SESSION from (default `process.env`). */
  procEnv?: Record<string, string | undefined>;
}

const piSessionCache = new Map<string, AgentSession>();

/**
 * Resolve the gate context from `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION`. No `env`
 * is passed to the session so no `session_created` audit row is written per call;
 * capabilities are still room-resolved from config.
 */
export function piContext(options: PiHarborOptions = {}): GateContext {
  const env = options.env ?? Environment.default();
  const procEnv = options.procEnv ?? process.env;
  // Blank or still-a-placeholder normalizes to absent — see normalizeRoomEnv
  // in ../src/config.ts for why `??` alone let those become the session's room.
  const room = normalizeRoomEnv(procEnv.AGENT_ENV_ROOM) ?? env.config.skillDefaultRoom;
  const sessionId = procEnv.AGENT_ENV_SESSION ?? "";
  const memoKey = `${room}:${sessionId}`;
  let session = piSessionCache.get(memoKey);
  if (!session) {
    session = new AgentSession({
      room,
      capabilities: env.config.roomCapabilities(room),
      ...(sessionId ? { sessionId } : {}),
    });
    piSessionCache.set(memoKey, session);
  }
  return { env, session };
}

// ── Wrapped gated primitives (hypervisor boundary) ───────────────────────────

const readSkillGated = gate("read_skill", readSkillImpl);
const listSkillsGated = gate("list_skills", listSkillsImpl);
const searchSkillsGated = gate("search_skills", searchSkillsImpl);
const activateSkillGated = gate("activate_skill", activateSkillImpl);
const deactivateSkillGated = gate("deactivate_skill", deactivateSkillImpl);

/** Search skills in the session's room by query. */
async function searchSkillsImpl(
  query: string,
  roomOverride?: string,
  limit: number = 5,
): Promise<PiToolResult> {
  const { env, session } = currentGateContext();
  if (roomOverride && roomOverride !== session.room && !session.has(Capability.ADMIN)) {
    const reason = `room '${session.room}' may not search skills for room '${roomOverride}'`;
    audit.deny(session.sessionId, "search_skills", roomOverride, reason, { room: session.room, env });
    return {
      content: [{ type: "text", text: `Access denied: ${reason}.` }],
      details: { error: "access_denied", room: roomOverride },
    };
  }
  const room = roomOverride ?? session.room;
  const results = searchSkills(env, query, room, limit);
  if (results.length === 0) {
    return {
      content: [{ type: "text", text: `No skills matched query "${query}" in room "${room}".` }],
      details: { query, room, count: 0 },
    };
  }
  const lines = [`Matching skills in room "${room}" (${results.length}):`, ""];
  for (const s of results) lines.push(`- ${s.name}: ${s.description || "(see SKILL.md)"}`);
  lines.push("", "To load a skill sequentially, call activate_skill with skill_name.");
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { query, room, count: results.length, matches: results.map((r) => r.name) },
  };
}

/** Activate a skill for sequential execution. */
async function activateSkillImpl(skillName: string): Promise<PiToolResult> {
  const { env, session } = currentGateContext();
  const detail = getSkill(env, skillName);
  if (!detail || !detail.skillMd) {
    return {
      content: [{ type: "text", text: `Skill '${skillName}' not found in the pool.` }],
      details: { error: "not_found", skill: skillName },
    };
  }
  const tokens = estimateTokens(detail.content);
  const budgetOpts = { env, room: session.room, tokenLimit: env.config.roomBudget(session.room) };

  const check = checkBudget(session.sessionId, `skill:${skillName}`, tokens, budgetOpts);
  if (!check.ok) {
    audit.deny(session.sessionId, "activate_skill", skillName, check.reason ?? "budget exceeded", {
      room: session.room,
      env,
    });
    return {
      content: [{ type: "text", text: `Token budget exceeded: ${check.reason ?? "no budget"}.` }],
      details: { error: "budget_exceeded", skill: skillName, remaining: check.remaining, limit: check.limit },
    };
  }

  spendBudget(session.sessionId, `skill:${skillName}`, tokens, budgetOpts);
  session.activeSkill = skillName;
  session.activeSkillStartedAt = Date.now() / 1000;
  audit.allow(session.sessionId, "activate_skill", skillName, `activated ${tokens} tokens`, {
    room: session.room,
    env,
  });
  const banner = `[HARBOR: SKILL '${skillName}' IS NOW ACTIVE]\nSequential policy: Focus exclusively on '${skillName}' until complete. Call deactivate_skill when finished.\n---\n\n`;
  return {
    content: [{ type: "text", text: banner + detail.content }],
    details: { skill: skillName, tokens, room: session.room, active: true },
  };
}

/** Deactivate active skill. */
async function deactivateSkillImpl(): Promise<PiToolResult> {
  const { env, session } = currentGateContext();
  const previous = session.activeSkill;
  session.activeSkill = null;
  session.activeSkillStartedAt = null;
  audit.allow(session.sessionId, "deactivate_skill", previous ?? "none", "deactivated skill", {
    room: session.room,
    env,
  });
  return {
    content: [
      {
        type: "text",
        text: previous
          ? `Skill '${previous}' deactivated. Context is ready for a new skill.`
          : `No active skill was set. Context is ready for a new skill.`,
      },
    ],
    details: { previousSkill: previous, active: false },
  };
}

/** Read a skill's content, gated by room + budget. */
async function readSkillImpl(skillName: string): Promise<PiToolResult> {
  const { env, session } = currentGateContext();
  const detail = getSkill(env, skillName);
  if (!detail || !detail.skillMd) {
    return {
      content: [{ type: "text", text: `Skill "${skillName}" not found in the shared pool.` }],
      details: { error: "not_found", skill: skillName },
    };
  }
  const tokens = estimateTokens(detail.content);
  const budgetOpts = { env, room: session.room, tokenLimit: env.config.roomBudget(session.room) };

  const check = checkBudget(session.sessionId, `skill:${skillName}`, tokens, budgetOpts);
  if (!check.ok) {
    audit.deny(session.sessionId, "read_skill", skillName, check.reason ?? "budget exceeded", {
      room: session.room,
      env,
    });
    return {
      content: [{ type: "text", text: `Token budget exceeded: ${check.reason ?? "no budget"}.` }],
      details: { error: "budget_exceeded", skill: skillName, remaining: check.remaining, limit: check.limit },
    };
  }

  spendBudget(session.sessionId, `skill:${skillName}`, tokens, budgetOpts);
  audit.allow(session.sessionId, "read_skill", skillName, `loaded ${tokens} tokens`, {
    room: session.room,
    env,
  });
  return {
    content: [{ type: "text", text: detail.content }],
    details: { skill: skillName, tokens, room: session.room },
  };
}

/** List the skills available to the session's room (or an authorized override). */
async function listSkillsImpl(roomOverride?: string): Promise<PiToolResult> {
  const { env, session } = currentGateContext();
  if (roomOverride && roomOverride !== session.room && !session.has(Capability.ADMIN)) {
    const reason = `room '${session.room}' may not list skills for room '${roomOverride}'`;
    audit.deny(session.sessionId, "list_skills", roomOverride, reason, { room: session.room, env });
    return {
      content: [{ type: "text", text: `Access denied: ${reason}.` }],
      details: { error: "access_denied", room: roomOverride },
    };
  }
  const room = roomOverride ?? session.room;
  const skills = listSkills(env, room);
  if (skills.length === 0) {
    return {
      content: [{ type: "text", text: `No skills available in room "${room}".` }],
      details: { room, count: 0 },
    };
  }
  const lines = [`Skills in room "${room}" (${skills.length}):`, ""];
  for (const s of skills) lines.push(`- ${s.name}: ${s.description || "(see SKILL.md)"}`);
  lines.push("", "Load one with read_skill <skill_name> or activate_skill.");
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { room, count: skills.length },
  };
}

// ── Public tool functions (run inside the gate context) ───────────────────────

/** Search skills in-process, bound to `context`. */
export async function searchSkillsTool(
  context: GateContext,
  query: string,
  room?: string,
  limit?: number,
): Promise<PiToolResult> {
  const q = query.trim();
  if (!q) {
    return {
      content: [{ type: "text", text: "Error: query is required." }],
      details: { error: "empty_query" },
    };
  }
  return runWithGateContext(context, async () => {
    try {
      return await searchSkillsGated(q, room, limit);
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return {
          content: [{ type: "text", text: `Access denied: ${err.message}` }],
          details: { error: "access_denied" },
        };
      }
      throw err;
    }
  });
}

/** Activate a skill in-process, bound to `context`. */
export async function activateSkill(context: GateContext, skillName: string): Promise<PiToolResult> {
  const name = skillName.trim().toLowerCase();
  if (!name) {
    return {
      content: [{ type: "text", text: "Error: skill_name is required." }],
      details: { error: "empty_skill_name" },
    };
  }
  return runWithGateContext(context, async () => {
    try {
      return await activateSkillGated(name);
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return {
          content: [{ type: "text", text: `Access denied: ${err.message}` }],
          details: { error: "access_denied", skill: name },
        };
      }
      if (err instanceof BudgetExceededError) {
        return {
          content: [{ type: "text", text: `Budget exceeded: ${err.message}` }],
          details: { error: "budget_exceeded", skill: name },
        };
      }
      throw err;
    }
  });
}

/** Deactivate active skill in-process, bound to `context`. */
export async function deactivateSkill(context: GateContext): Promise<PiToolResult> {
  return runWithGateContext(context, async () => {
    return await deactivateSkillGated();
  });
}

/** Read a skill in-process, bound to `context`. Never throws — denials are results. */
export async function readSkill(context: GateContext, skillName: string): Promise<PiToolResult> {
  const name = skillName.trim().toLowerCase();
  if (!name) {
    return {
      content: [{ type: "text", text: "Error: skill_name is required." }],
      details: { error: "empty_skill_name" },
    };
  }
  return runWithGateContext(context, async () => {
    try {
      return await readSkillGated(name);
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return {
          content: [{ type: "text", text: `Access denied: ${err.message}` }],
          details: { error: "access_denied", skill: name },
        };
      }
      if (err instanceof BudgetExceededError) {
        return {
          content: [{ type: "text", text: `Budget exceeded: ${err.message}` }],
          details: { error: "budget_exceeded", skill: name },
        };
      }
      throw err;
    }
  });
}

/** List skills in-process, bound to `context`. */
export async function listSkillsTool(context: GateContext, room?: string): Promise<PiToolResult> {
  return runWithGateContext(context, async () => {
    try {
      return await listSkillsGated(room);
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return {
          content: [{ type: "text", text: `Access denied: ${err.message}` }],
          details: { error: "access_denied" },
        };
      }
      throw err;
    }
  });
}

// ── Pi extension registration ─────────────────────────────────────────────────

/**
 * Register Harbor's tools on a Pi extension API.
 */
export function registerHarborSkills(pi: PiExtensionApi, options: PiHarborOptions = {}): void {
  pi.registerTool({
    name: "search_skills",
    label: "Search Skills",
    description:
      "Search skills available to the current room by query. Returns lean summaries (<150 tokens) " +
      "to avoid bloating context.",
    promptSnippet: "Search skills by query (room-scoped, lean).",
    promptGuidelines: [
      "Use search_skills first to find the single skill you need for the task.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or task description." },
        room: { type: "string", description: "Optional room override (defaults to session room)." },
        limit: { type: "number", description: "Max results (default 5)." },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params) {
      const query = typeof params.query === "string" ? params.query : "";
      const room = typeof params.room === "string" && params.room ? params.room : undefined;
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      return searchSkillsTool(piContext(options), query, room, limit);
    },
  });

  pi.registerTool({
    name: "activate_skill",
    label: "Activate Skill",
    description:
      "Activate a skill for sequential execution. Loads instructions and sets as single active skill.",
    promptSnippet: "Activate a skill by name (sequential execution).",
    promptGuidelines: [
      "Use activate_skill to load instructions for the skill you are executing.",
      "Work with ONE skill at a time. Call deactivate_skill when finished.",
    ],
    parameters: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Slug of the skill to activate." },
      },
      required: ["skill_name"],
    },
    async execute(_toolCallId, params) {
      const skill = typeof params.skill_name === "string" ? params.skill_name : "";
      return activateSkill(piContext(options), skill);
    },
  });

  pi.registerTool({
    name: "deactivate_skill",
    label: "Deactivate Skill",
    description: "Deactivate the currently active skill to clear context.",
    promptSnippet: "Deactivate current skill.",
    promptGuidelines: [
      "Call deactivate_skill when done with a skill before activating another.",
    ],
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, _params) {
      return deactivateSkill(piContext(options));
    },
  });

  pi.registerTool({
    name: "read_skill",
    label: "Read Skill",
    description:
      "Load a skill's full SKILL.md file by name, gated by the session's room and " +
      "token budget. Use this instead of expecting skill content to be in the prompt.",
    promptSnippet: "Read a skill's SKILL.md by name (on-demand, room-gated, budgeted).",
    promptGuidelines: [
      "Use read_skill or activate_skill to load instructions when the task matches its description.",
      "Do NOT assume skill content is already in context.",
    ],
    parameters: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Slug of the skill to load (see list_skills)." },
      },
      required: ["skill_name"],
    },
    async execute(_toolCallId, params) {
      const skill = typeof params.skill_name === "string" ? params.skill_name : "";
      return readSkill(piContext(options), skill);
    },
  });

  pi.registerTool({
    name: "list_skills",
    label: "List Skills",
    description:
      "List the skills available to the current session's room, with one-line " +
      "descriptions. Call this to discover skills before loading one with read_skill.",
    promptSnippet: "List the room's available skills.",
    promptGuidelines: [
      "Use search_skills or list_skills to discover skills, then activate_skill to load one.",
    ],
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", description: "Optional room override (defaults to the session room)." },
      },
    },
    async execute(_toolCallId, params) {
      const room = typeof params.room === "string" && params.room ? params.room : undefined;
      return listSkillsTool(piContext(options), room);
    },
  });
}

/**
 * Pi extension entry point. Drop-in replacement for the old skill-accessor.ts:
 *
 *   // ~/.pi/agent/extensions/skill-accessor.ts
 *   export { default } from "harbor-tugboat/integrations/pi";
 *
 * Pi calls this with its ExtensionAPI; Harbor registers the gated tools.
 */
export default function harborSkillExtension(pi: PiExtensionApi): void {
  registerHarborSkills(pi);
}
