/**
 * channel-tools.ts — Resolve a Buzz channel to the skills + MCP servers it
 * exposes, by reading the SAME `channel-tools.toml` that buzz-acp's enforcement
 * reads.
 *
 * A Buzz channel maps to a Harbor room (`[channels.<name>] room = "<room>"`);
 * the room is the source of truth for that channel's skills and MCP servers.
 * This module is the read side the Buzz GUI panel renders from — so the panel,
 * the CLI, and buzz-acp's enforcement all agree on one policy file rather than
 * three notions of "what's in this channel".
 *
 * The `channel-tools.toml` schema is fixed by buzz-acp's deserializer (verified
 * against the live file, not guessed):
 *
 *   harbor_command = "/path/to/harbor"        # default binary for `room` entries
 *   [channels.<name-or-uuid>]
 *   room = "<harbor-room>"                     # → harbor mcp-server --room=<room>
 *   harbor_command = "..."                     # optional per-entry override
 *   [[channels.<name>.mcp]]                    # optional EXTRA explicit servers
 *   name = "..."; command = "..."; args = [...]
 *
 * A channel key matches by exact string OR case-insensitively by name (buzz-acp
 * matches names case-insensitively; UUIDs are exact). Adding a skill/MCP to a
 * channel is adding it to that channel's ROOM — `harbor skill-install --room`,
 * `skill-room-add`, `mcp-add --room` — which is why this file only READS: the
 * mutations already have their own audited commands.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { ensureRoomInConfig, isValidRoomName } from "./config-edit.ts";
import type { Environment } from "./env.ts";
import { findSkillDir, getSkillDescription } from "./skills.ts";

/** Default location buzz-acp uses (`~/.buzz/channel-tools.toml`). */
export function defaultPolicyPath(home: string = homedir()): string {
  return join(home, ".buzz", "channel-tools.toml");
}

export class ChannelToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelToolsError";
  }
}

/** One explicit MCP server declared inline in the policy for a channel. */
export interface ExplicitMcpServer {
  name: string;
  command: string;
  args: string[];
}

/** A channel's entry as written in the policy file. */
export interface ChannelPolicy {
  /** The policy key it matched under (name or UUID). */
  key: string;
  /** The Harbor room this channel maps to, if any. */
  room: string | null;
  /** Explicit MCP servers declared for this channel (additive with the room). */
  explicitMcp: ExplicitMcpServer[];
}

/** A skill visible in a channel (via its room). */
export interface ChannelSkill {
  name: string;
  description: string;
  /** False when the room lists it but it is missing from the pool. */
  present: boolean;
}

/** The fully-resolved toolset a channel exposes. */
export interface ChannelTools {
  channel: string;
  /** Null when the channel has no policy entry (unscoped — Harbor not applied). */
  room: string | null;
  /** True when the channel has a policy entry at all. */
  scoped: boolean;
  skills: ChannelSkill[];
  /** MCP servers: the room's configured servers plus any explicit inline ones. */
  mcpServers: Array<{ name: string; source: "room" | "explicit" }>;
}

type Toml = Record<string, unknown>;

/** Parse a `channel-tools.toml` and return its channel → policy map. */
export function loadPolicy(path: string): { harborCommand: string; channels: Map<string, ChannelPolicy> } {
  if (!existsSync(path)) {
    throw new ChannelToolsError(`channel-tools policy not found at ${path}`);
  }
  const data = parseToml(readFileSync(path, "utf8")) as Toml;
  const harborCommand = typeof data.harbor_command === "string" ? data.harbor_command : "harbor";

  const channels = new Map<string, ChannelPolicy>();
  const rawChannels = (data.channels ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(rawChannels)) {
    if (value == null || typeof value !== "object") continue;
    const v = value as Toml;
    const room = typeof v.room === "string" && v.room.trim() ? v.room.trim() : null;
    const explicitMcp: ExplicitMcpServer[] = Array.isArray(v.mcp)
      ? (v.mcp as Toml[])
          .filter((m) => m && typeof m === "object" && typeof m.name === "string" && typeof m.command === "string")
          .map((m) => ({
            name: String(m.name),
            command: String(m.command),
            args: Array.isArray(m.args) ? m.args.map(String) : [],
          }))
      : [];
    channels.set(key, { key, room, explicitMcp });
  }
  return { harborCommand, channels };
}

/**
 * Find a channel's policy entry, matching buzz-acp's rules: exact key first,
 * then case-insensitive name (UUID keys only ever match exactly, which an exact
 * check already covers).
 */
export function findChannelPolicy(
  channels: Map<string, ChannelPolicy>,
  channel: string,
): ChannelPolicy | null {
  const exact = channels.get(channel);
  if (exact) return exact;
  const lower = channel.toLowerCase();
  for (const [key, policy] of channels) {
    if (key.toLowerCase() === lower) return policy;
  }
  return null;
}

/**
 * Resolve everything a channel exposes: its room, that room's skills (with
 * presence), and its MCP servers (room-configured + explicit inline).
 *
 * An unscoped channel (no policy entry) returns `scoped: false` with empty
 * lists — the Buzz GUI renders that as "not Harbor-scoped", which is the
 * honest state, not an error.
 */
export function resolveChannelTools(env: Environment, policyPath: string, channel: string): ChannelTools {
  const { channels } = loadPolicy(policyPath);
  const policy = findChannelPolicy(channels, channel);

  if (!policy || !policy.room) {
    return {
      channel,
      room: policy?.room ?? null,
      scoped: policy != null,
      skills: [],
      mcpServers: (policy?.explicitMcp ?? []).map((m) => ({ name: m.name, source: "explicit" as const })),
    };
  }

  const room = policy.room;
  const skills: ChannelSkill[] = [...env.config.roomSkillSet(room)].sort().map((name) => {
    const dir = findSkillDir(env, name);
    return {
      name,
      description: dir ? getSkillDescription(dir) : "",
      present: dir != null,
    };
  });

  const roomServers = env.config.roomMcpServers(room).map((name) => ({ name, source: "room" as const }));
  const explicit = policy.explicitMcp.map((m) => ({ name: m.name, source: "explicit" as const }));

  return { channel, room, scoped: true, skills, mcpServers: [...roomServers, ...explicit] };
}

/** Every channel in the policy plus its resolved room (for a directory view). */
export function listChannels(policyPath: string): Array<{ channel: string; room: string | null }> {
  const { channels } = loadPolicy(policyPath);
  return [...channels.values()].map((p) => ({ channel: p.key, room: p.room })).sort((a, b) => a.channel.localeCompare(b.channel));
}

/** TOML bare-key charset — a key matching this needs no quoting. */
const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Derive a valid room name from a channel key. A channel that is already a
 * legal room name (e.g. "welcome-everyone") is used verbatim so the mapping
 * reads naturally; otherwise it is slugified to the room-name charset.
 */
export function deriveRoomName(channel: string): string {
  const trimmed = channel.trim();
  if (isValidRoomName(trimmed)) return trimmed;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 64);
  return slug || "channel";
}

/** Render a channel key as a TOML table key, quoting only when it isn't a bare key. */
function tomlKey(key: string): string {
  return BARE_KEY_RE.test(key) ? key : `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The outcome of mapping a channel to a room. */
export interface MapResult {
  channel: string;
  room: string;
  /** False when the channel was already mapped (idempotent no-op). */
  mappingCreated: boolean;
}

/**
 * Ensure a Buzz channel is scoped: create its room in Harbor's config (empty if
 * new) and record the channel → room mapping in `channel-tools.toml`. This is
 * the "on the fly" write the GUI uses so a channel needs no hand-edited policy
 * before you can add a skill or MCP server to it.
 *
 * Idempotent: a channel already mapped to a room keeps that room (its skills
 * are untouched). A brand-new mapping is APPENDED so the file's comments and
 * every existing entry are preserved; only the rare case of an entry that
 * exists without a room falls back to a parse→mutate→stringify rewrite.
 */
export function mapChannel(
  env: Environment,
  policyPath: string,
  channel: string,
  room?: string,
): MapResult {
  const chan = channel.trim();
  if (!chan) throw new ChannelToolsError("channel must not be empty");

  let existing: ChannelPolicy | null = null;
  if (existsSync(policyPath)) {
    const { channels } = loadPolicy(policyPath);
    existing = findChannelPolicy(channels, chan);
    if (existing?.room) {
      // Already scoped — keep the mapping, just make sure the room exists.
      ensureRoomInConfig(env, existing.room);
      return { channel: chan, room: existing.room, mappingCreated: false };
    }
  }

  const targetRoom = room?.trim() ? room.trim() : deriveRoomName(chan);
  if (!isValidRoomName(targetRoom)) {
    throw new ChannelToolsError(`'${targetRoom}' is not a valid room name (allowed: letters, digits, _ and -, max 64)`);
  }
  ensureRoomInConfig(env, targetRoom);

  const block = `\n[channels.${tomlKey(chan)}]\nroom = "${targetRoom}"\n`;
  if (existing) {
    // Rare: the channel has an entry but no room. Editing the table in place
    // (parse→mutate→stringify) avoids writing a duplicate [channels.X] header,
    // which would make the file fail to parse.
    const data = parseToml(readFileSync(policyPath, "utf8")) as Toml;
    const channelsTbl = (data.channels ?? (data.channels = {})) as Record<string, Toml>;
    const table = (channelsTbl[existing.key] ?? (channelsTbl[existing.key] = {})) as Toml;
    table.room = targetRoom;
    writeFileSync(policyPath, `${stringifyToml(data)}\n`);
  } else if (!existsSync(policyPath)) {
    writeFileSync(policyPath, `harbor_command = "harbor"\n${block}`);
  } else {
    appendFileSync(policyPath, block);
  }
  return { channel: chan, room: targetRoom, mappingCreated: true };
}
