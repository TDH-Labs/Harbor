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
import {
  Capability,
  Environment,
  AgentSession,
  audit,
  checkBudget,
  spendBudget,
  gate,
  runWithGateContext,
  currentGateContext,
  estimateTokens,
  getSkill,
  listSkills,
  AccessDeniedError,
  BudgetExceededError,
  type GateContext,
  normalizeRoomEnv,
} from "harbor-tugboat";

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
  const sessionId = procEnv.AGENT_ENV_SESSION;
  const session = new AgentSession({
    room,
    capabilities: env.config.roomCapabilities(room),
    ...(sessionId ? { sessionId } : {}),
  });
  return { env, session };
}

// ── Tool logic (session resolved from the ambient gate context) ───────────────

const readSkillGated = gate("read_skill", readSkillImpl);
const listSkillsGated = gate("list_skills", listSkillsImpl);

/** Load a skill's SKILL.md, gated + budgeted. Resolves the session from ALS. */
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
  // B1 — gate the room override. A caller-supplied room that differs from the
  // session's own is a cross-room enumeration; permit it only for an ADMIN
  // session. Otherwise deny (audited): a restricted session must not be able to
  // enumerate another room's skill list by passing room=<other>.
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
  lines.push("", "Load one with read_skill <skill_name>.");
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { room, count: skills.length },
  };
}

// ── Public tool functions (run inside the gate context) ───────────────────────

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
 * Register Harbor's `read_skill` / `list_skills` tools on a Pi extension API.
 * Each tool resolves its session per call from `AGENT_ENV_ROOM` /
 * `AGENT_ENV_SESSION` (via {@link piContext}) and runs inside the gate context.
 */
export function registerHarborSkills(pi: PiExtensionApi, options: PiHarborOptions = {}): void {
  pi.registerTool({
    name: "read_skill",
    label: "Read Skill",
    description:
      "Load a skill's full SKILL.md file by name, gated by the session's room and " +
      "token budget. Use this instead of expecting skill content to be in the prompt.",
    promptSnippet: "Read a skill's SKILL.md by name (on-demand, room-gated, budgeted).",
    promptGuidelines: [
      "Use read_skill to load a skill's full instructions when the task matches its description.",
      "Do NOT assume skill content is already in context — load what you need with read_skill.",
      "Use list_skills to discover which skills are available in the current room.",
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
      "Use list_skills first to discover what skills are available, then read_skill to load one.",
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
