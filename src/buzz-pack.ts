/**
 * buzz-pack.ts — Emit a Buzz Persona Pack from Harbor rooms.
 *
 * Buzz (github.com/block/buzz) defines an agent with a "Persona Pack": a
 * directory holding each agent's persona (system prompt + config), its MCP
 * servers, and its skills. Harbor already owns all three — rooms, room skills,
 * room MCP servers — so this is a TRANSLATOR, not a second source of truth:
 * Harbor stays authoritative and Buzz becomes a render target, the same way
 * `harbor install --for <agent>` renders an MCP entry per client.
 *
 * ONE HARBOR ROOM → ONE BUZZ PERSONA. A room's skills become that persona's
 * `skills:`, its MCP servers become its `mcp_servers:`, and the whole
 * environment emits as a single pack with N personas.
 *
 * SCHEMA IS PINNED TO THE REAL DESERIALIZER, not the spec prose. Verified
 * against block/buzz @ 6a56c8bdac6d115a0d6d48b24a2a04dc46b336c5 by reading
 * `crates/buzz-persona/src/{persona,manifest,resolve,pack}.rs`. The spec
 * markdown and the code disagree in several places; the code wins because it
 * is what parses. The traps that shape this file:
 *
 *   1. Persona frontmatter is `deny_unknown_fields` — ANY key outside the
 *      struct is a HARD parse error that fails the whole pack. Only emit keys
 *      in {@link PERSONA_FIELDS}.
 *   2. `name`, `display_name`, `description` are required and must be
 *      NON-EMPTY after trim. Several Harbor rooms carry an empty description,
 *      so one is synthesized rather than emitted blank.
 *   3. `.mcp.json`'s top key is `mcpServers` (camelCase) and is a MAP of
 *      name → config; `env` is an OBJECT {K:V}. The array-of-{name,value}
 *      form exists only on the ACP wire, never in a pack file.
 *   4. stdio ONLY. `streamable_http` appears in the spec prose but in zero
 *      lines of Rust; a server without `command` is silently DROPPED, so an
 *      http-only room server is reported rather than emitted into a void.
 *   5. `pack.lock` / `.buzzpack` are spec fiction — nothing reads them. Not
 *      emitted.
 *   6. Persona `hooks` parse but never execute; not emitted.
 *
 * PRIVACY: a pack embeds room descriptions and skill CONTENT verbatim. On a
 * real machine those describe live clients and internal operations. A pack is
 * local output — treat publishing one the same as publishing the skills
 * themselves. {@link findSensitive} exists so the CLI can warn before a pack
 * leaves the machine.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Environment } from "./env.ts";
import { findSkillDir } from "./skills.ts";

/**
 * Every key the persona frontmatter deserializer accepts. Emitting anything
 * else is a hard parse error (`deny_unknown_fields`), so this list is the
 * contract — kept here so a future field addition is a deliberate edit.
 */
export const PERSONA_FIELDS = [
  "name",
  "display_name",
  "avatar",
  "description",
  "version",
  "author",
  "skills",
  "mcp_servers",
  "subscribe",
  "triggers",
  "model",
  "runtime",
  "temperature",
  "max_context_tokens",
  "thread_replies",
  "broadcast_replies",
  "hooks",
] as const;

/** Buzz persona name charset, from validate.rs: `[a-zA-Z0-9_-]+`, max 64. */
const PERSONA_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class BuzzPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuzzPackError";
  }
}

/** An MCP server as it appears in a pack file (stdio only — see trap 4). */
export interface BuzzMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** One emitted persona, before serialization. */
export interface BuzzPersona {
  name: string;
  display_name: string;
  description: string;
  skills: string[];
  mcp_servers: BuzzMcpServer[];
  subscribe: string[];
}

export interface BuzzPackPlan {
  packId: string;
  packName: string;
  version: string;
  personas: BuzzPersona[];
  /** Skill names to copy into `<pack>/skills/`, deduped across personas. */
  skillsToCopy: string[];
  /** Room MCP servers that could NOT be emitted (no `command` → stdio-only). */
  droppedServers: Array<{ room: string; server: string; reason: string }>;
  /** Skills named by a room but absent from the pool — would break the pack. */
  missingSkills: Array<{ room: string; skill: string }>;
}

/** Turn a room name into a valid Buzz persona name, or explain why it can't be. */
export function personaNameFor(room: string): string {
  const candidate = room.trim();
  if (!PERSONA_NAME_RE.test(candidate)) {
    throw new BuzzPackError(
      `room '${room}' is not a valid Buzz persona name — Buzz requires [A-Za-z0-9_-], max 64 chars`,
    );
  }
  return candidate;
}

/** `client_services` → `Client Services`. Never empty (name is validated). */
export function displayNameFor(room: string): string {
  return room
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * A persona `description` is REQUIRED and must be non-empty after trim, but
 * plenty of Harbor rooms have none. Synthesize a truthful one rather than
 * emitting a blank that fails the pack.
 */
export function descriptionFor(room: string, configured: string, skillCount: number): string {
  const trimmed = (configured ?? "").trim();
  if (trimmed) return trimmed;
  return `Harbor '${room}' room — ${skillCount} skill${skillCount === 1 ? "" : "s"} scoped to this domain.`;
}

/**
 * Build the emission plan for a whole environment (or one room).
 *
 * Pure: reads config + checks the pool for skill existence, writes nothing.
 * Everything that cannot be represented in Buzz is REPORTED (droppedServers,
 * missingSkills) rather than silently omitted — Buzz itself drops a
 * command-less MCP server with no warning, so this is where it gets noticed.
 */
export function planPack(
  env: Environment,
  options: { room?: string; packId?: string; packName?: string; version?: string } = {},
): BuzzPackPlan {
  const allRooms = Object.keys(env.config.roomSkills);
  const rooms = options.room ? [options.room] : allRooms;
  if (options.room && !allRooms.includes(options.room)) {
    throw new BuzzPackError(`room '${options.room}' is not configured`);
  }
  if (rooms.length === 0) {
    throw new BuzzPackError("no rooms configured — nothing to emit");
  }

  const personas: BuzzPersona[] = [];
  const skillsToCopy = new Set<string>();
  const droppedServers: BuzzPackPlan["droppedServers"] = [];
  const missingSkills: BuzzPackPlan["missingSkills"] = [];

  for (const room of rooms) {
    const raw = env.config.roomSkills[room] as { description?: string } | undefined;
    const skills = [...env.config.roomSkillSet(room)].sort();

    const skillRefs: string[] = [];
    for (const skill of skills) {
      if (!findSkillDir(env, skill)) {
        missingSkills.push({ room, skill });
        continue;
      }
      skillsToCopy.add(skill);
      // The example pack uses the `./skills/<name>/` form; the loader accepts
      // bare names too, but mirroring the example is the safest shape.
      skillRefs.push(`./skills/${skill}/`);
    }

    const servers: BuzzMcpServer[] = [];
    for (const s of rawServersFor(env, room)) {
      if (!s.command) {
        droppedServers.push({
          room,
          server: s.name || "(unnamed)",
          reason: "no `command` — Buzz packs are stdio-only and would silently drop this",
        });
        continue;
      }
      servers.push({ name: s.name, command: s.command, args: s.args ?? [], env: s.env ?? {} });
    }

    personas.push({
      name: personaNameFor(room),
      display_name: displayNameFor(room),
      description: descriptionFor(room, raw?.description ?? "", skills.length),
      skills: skillRefs,
      mcp_servers: servers,
      // One channel per room keeps Buzz's channel scoping aligned with
      // Harbor's room scoping — the whole point of the mapping.
      subscribe: [`#${room}`],
    });
  }

  return {
    packId: options.packId ?? "com.harbor.rooms",
    packName: options.packName ?? "Harbor Rooms",
    version: options.version ?? "0.1.0",
    personas,
    skillsToCopy: [...skillsToCopy].sort(),
    droppedServers,
    missingSkills,
  };
}

/** Read a room's configured MCP servers in Harbor's own shape. */
function rawServersFor(
  env: Environment,
  room: string,
): Array<{ name: string; command?: string; args?: string[]; env?: Record<string, string> }> {
  const raw = env.config.roomSkills[room] as
    | { mcp?: { servers?: Array<Record<string, unknown>> } }
    | undefined;
  const servers = raw?.mcp?.servers ?? [];
  return servers.map((s) => ({
    name: String(s.name ?? ""),
    ...(typeof s.command === "string" ? { command: s.command } : {}),
    ...(Array.isArray(s.args) ? { args: s.args.map(String) } : {}),
    ...(s.env && typeof s.env === "object" && !Array.isArray(s.env)
      ? { env: Object.fromEntries(Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
      : {}),
  }));
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Quote a YAML scalar. Buzz's example quotes display_name/description. */
function yamlStr(s: string): string {
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

/**
 * Render one `.persona.md`. ONLY keys from {@link PERSONA_FIELDS} appear —
 * `deny_unknown_fields` makes any extra key fatal to the entire pack.
 */
export function renderPersona(p: BuzzPersona, body: string): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${p.name}`);
  lines.push(`display_name: ${yamlStr(p.display_name)}`);
  lines.push(`description: ${yamlStr(p.description)}`);
  if (p.subscribe.length > 0) {
    lines.push("subscribe:");
    for (const c of p.subscribe) lines.push(`  - ${yamlStr(c)}`);
  }
  if (p.skills.length > 0) {
    lines.push("skills:");
    for (const s of p.skills) lines.push(`  - ${s}`);
  }
  if (p.mcp_servers.length > 0) {
    lines.push("mcp_servers:");
    for (const s of p.mcp_servers) {
      lines.push(`  - name: ${yamlStr(s.name)}`);
      lines.push(`    command: ${yamlStr(s.command)}`);
      if (s.args.length > 0) {
        lines.push("    args:");
        for (const a of s.args) lines.push(`      - ${yamlStr(a)}`);
      }
      const envKeys = Object.keys(s.env);
      if (envKeys.length > 0) {
        lines.push("    env:");
        // env is an OBJECT here; the [{name,value}] form is ACP-wire only.
        for (const k of envKeys.sort()) lines.push(`      ${k}: ${yamlStr(s.env[k]!)}`);
      }
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(body.trimEnd());
  lines.push("");
  return lines.join("\n");
}

/** The persona's system prompt — what the agent is, in Harbor's terms. */
export function personaBody(p: BuzzPersona): string {
  const out = [
    `You are the ${p.display_name} agent.`,
    "",
    p.description,
    "",
  ];
  if (p.skills.length > 0) {
    out.push(
      `Your skills are scoped to this domain. Load one before acting on a task it covers, ` +
        `rather than improvising from memory.`,
      "",
    );
  }
  out.push(
    "Stay within your domain. If a request belongs to another team's area, say so and hand it off " +
      "instead of reaching outside your scope.",
  );
  return out.join("\n");
}

/** Render `.plugin/plugin.json`. Required: id, name, version (+ personas in practice). */
export function renderManifest(plan: BuzzPackPlan): string {
  return (
    JSON.stringify(
      {
        $schema: "https://open-plugin-spec.org/schema/v1/plugin.json",
        id: plan.packId,
        name: plan.packName,
        version: plan.version,
        description: `Harbor rooms as Buzz personas — ${plan.personas.length} room(s), generated by \`harbor buzz-pack\`.`,
        personas: plan.personas.map((p) => `agents/${p.name}.persona.md`),
        pack_instructions: "instructions.md",
      },
      null,
      2,
    ) + "\n"
  );
}

/** Pack-level instructions shared by every persona. */
export function renderInstructions(plan: BuzzPackPlan): string {
  return [
    "# Harbor rooms",
    "",
    "This pack was generated from a Harbor environment. Each persona corresponds to one",
    "Harbor room, and carries exactly that room's skills and MCP servers — the same",
    "scoping Harbor enforces for its own agents.",
    "",
    "Harbor remains the source of truth. Change a room in Harbor and re-run",
    "`harbor buzz-pack` rather than editing this pack by hand; hand edits are lost on",
    "the next emit.",
    "",
    `Rooms in this pack: ${plan.personas.map((p) => p.name).join(", ")}.`,
    "",
  ].join("\n");
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface WriteResult {
  outDir: string;
  personaFiles: string[];
  skillsCopied: number;
}

/**
 * Write the pack to `outDir`. Creates the directory tree, copies each named
 * skill from the pool, and emits the manifest + personas + instructions.
 *
 * Deliberately does NOT emit `pack.lock` or `.buzzpack.sha256` — the spec
 * describes both as mandatory, but no code in Buzz reads either.
 */
export function writePack(env: Environment, plan: BuzzPackPlan, outDir: string): WriteResult {
  mkdirSync(join(outDir, ".plugin"), { recursive: true });
  mkdirSync(join(outDir, "agents"), { recursive: true });

  writeFileSync(join(outDir, ".plugin", "plugin.json"), renderManifest(plan));
  writeFileSync(join(outDir, "instructions.md"), renderInstructions(plan));

  const personaFiles: string[] = [];
  for (const p of plan.personas) {
    const file = join(outDir, "agents", `${p.name}.persona.md`);
    writeFileSync(file, renderPersona(p, personaBody(p)));
    personaFiles.push(file);
  }

  let skillsCopied = 0;
  if (plan.skillsToCopy.length > 0) {
    mkdirSync(join(outDir, "skills"), { recursive: true });
    for (const skill of plan.skillsToCopy) {
      const src = findSkillDir(env, skill);
      if (!src || !existsSync(src)) continue;
      cpSync(src, join(outDir, "skills", skill), { recursive: true });
      skillsCopied++;
    }
  }

  return { outDir, personaFiles, skillsCopied };
}

// ── Privacy guard ────────────────────────────────────────────────────────────

/**
 * Terms that suggest a pack carries operator-private detail. This is a WARNING
 * aid for the CLI, not a gate: a pack legitimately contains the operator's own
 * skills, and it is only a problem when the pack is published. Deliberately
 * narrow — a noisy privacy warning gets ignored, the same failure the secrets
 * scanner had to be tuned away from.
 */
export function findSensitive(plan: BuzzPackPlan, terms: string[]): string[] {
  if (terms.length === 0) return [];
  const re = new RegExp(`\\b(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const hits: string[] = [];
  for (const p of plan.personas) {
    if (re.test(p.description)) hits.push(`persona '${p.name}' description`);
  }
  return hits;
}
