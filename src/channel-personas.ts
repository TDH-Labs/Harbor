/**
 * channel-personas.ts — Resolve, set, and remove a Buzz channel's persona
 * (system prompt), the same way `channel-tools.ts` handles its skills + MCP.
 *
 * A persona lives with the room, not the channel: each Harbor room holds its
 * agent persona(s) as markdown at `<rooms>/<room>/agents/<name>.md`. A channel
 * mapped to that room AUTO-DERIVES its persona from the room — no import step,
 * exactly like skills/MCP:
 *
 *   - room with ONE persona            → that persona
 *   - channel name matches a persona   → that persona (e.g. an `on-call`
 *                                        channel → `on-call.md`)
 *   - room with several, no name match → ambiguous; the panel offers a picker
 *
 * buzz-acp only reads `persona_file` from `channel-tools.toml`, so applying an
 * auto-derived persona means pointing `persona_file` at the LIVE room file (a
 * reference, never a copy — edit the room file and the persona updates). Setting
 * a custom persona writes an explicit override; removing clears it back to auto.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { findChannelPolicy, loadPolicy } from "./channel-tools.ts";
import type { Environment } from "./env.ts";

export class ChannelPersonaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelPersonaError";
  }
}

/** One persona file discovered in a room's `agents/` directory. */
export interface RoomPersona {
  /** Basename without `.md` — the persona's name. */
  name: string;
  /** Absolute path to the persona file. */
  path: string;
  /** A short human preview (the first substantive line of the body). */
  preview: string;
}

/** The persona a channel effectively runs under, and how it was chosen. */
export interface ChannelPersona {
  channel: string;
  room: string | null;
  /** The persona in effect, or null when the channel has none. */
  effective: {
    name: string;
    /** Where the prompt comes from: a room file, or an explicit inline override. */
    path: string | null;
    inline: string | null;
    source: "override-file" | "override-inline" | "room";
    preview: string;
  } | null;
  /** Every persona the mapped room offers, for the picker. */
  roomOptions: RoomPersona[];
  /** True when the room has several personas and none matches the channel name. */
  ambiguous: boolean;
  /** True when an explicit persona/persona_file override is set in the policy. */
  overridden: boolean;
}

/** Pull the first meaningful line out of a persona body for a compact preview. */
export function personaPreview(body: string, max = 140): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith(">")) continue; // title / provenance
    const clean = line.replace(/\*\*/g, "");
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  }
  return "";
}

/** List a room's persona files (`<rooms>/<room>/agents/*.md`). Empty if none. */
export function listRoomPersonas(env: Environment, room: string): RoomPersona[] {
  const dir = join(env.rooms, room, "agents");
  if (!existsSync(dir)) return [];
  const out: RoomPersona[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    let preview = "";
    try {
      preview = personaPreview(readFileSync(path, "utf8"));
    } catch {
      // Unreadable file: still list it by name so the picker shows something.
    }
    out.push({ name: entry.slice(0, -3), path, preview });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Split a channel/persona name into comparable lowercase tokens. */
function tokens(name: string): string[] {
  return name.toLowerCase().split(/[_\-\s]+/).filter(Boolean);
}

/**
 * Pick the room persona a channel should auto-use, or null when it can't be
 * decided unambiguously. Sole persona always wins. Otherwise, since a room's
 * channels are typically `<room>-<specialization>` and every persona shares the
 * room name, matching keys off the DISTINCTIVE tokens (room name dropped):
 *
 *   - exact name (`on-call` → `on-call.md`)
 *   - channel's distinctive tokens ⊇ a persona's (`region-eu-sales` →
 *     `eu-sales`), the most specific if several
 *   - a persona uniquely sharing a distinctive token (`team-billing` →
 *     `billing-clerk`)
 *
 * A bare room-name channel (no specialization) stays ambiguous — as it should.
 */
export function matchRoomPersona(channel: string, personas: RoomPersona[], room?: string): RoomPersona | null {
  if (personas.length === 0) return null;
  if (personas.length === 1) return personas[0]!;

  const exact = personas.find((p) => p.name.toLowerCase() === channel.toLowerCase());
  if (exact) return exact;

  const roomTokens = new Set(room ? tokens(room) : []);
  const distinct = (name: string) => tokens(name).filter((t) => !roomTokens.has(t));
  const chDistinct = new Set(distinct(channel));
  if (chDistinct.size === 0) return null; // channel is just the room name → ambiguous

  // Personas whose distinctive tokens all appear in the channel (channel is a
  // specialization of the persona). Take the most specific if several tie-break by count.
  const subset = personas
    .filter((p) => {
      const pt = distinct(p.name);
      return pt.length > 0 && pt.every((t) => chDistinct.has(t));
    })
    .sort((a, b) => distinct(b.name).length - distinct(a.name).length);
  if (subset.length === 1) return subset[0]!;
  if (subset.length > 1 && distinct(subset[0]!.name).length !== distinct(subset[1]!.name).length) {
    return subset[0]!;
  }

  // A persona uniquely sharing a distinctive token with the channel.
  const overlap = personas.filter((p) => distinct(p.name).some((t) => chDistinct.has(t)));
  if (overlap.length === 1) return overlap[0]!;

  return null;
}

/** Resolve the persona a channel effectively runs under (override → room-auto). */
export function resolveChannelPersona(env: Environment, policyPath: string, channel: string): ChannelPersona {
  const { channels } = loadPolicy(policyPath);
  const policy = findChannelPolicy(channels, channel);
  const room = policy?.room ?? null;
  const roomOptions = room ? listRoomPersonas(env, room) : [];

  // Explicit override wins.
  if (policy?.persona) {
    return {
      channel,
      room,
      effective: {
        name: "custom",
        path: null,
        inline: policy.persona,
        source: "override-inline",
        preview: personaPreview(policy.persona),
      },
      roomOptions,
      ambiguous: false,
      overridden: true,
    };
  }
  if (policy?.personaFile) {
    // Name it after the matching room persona when the path points into the room.
    const match = roomOptions.find((p) => policy.personaFile!.includes(p.name));
    let preview = "";
    const expanded = policy.personaFile.replace(/^~(?=\/)/, homedir());
    try {
      preview = personaPreview(readFileSync(expanded, "utf8"));
    } catch {
      preview = `(persona_file: ${policy.personaFile})`;
    }
    return {
      channel,
      room,
      effective: {
        name: match?.name ?? "custom",
        path: policy.personaFile,
        inline: null,
        // A persona_file that points at one of the room's personas IS that room
        // persona (auto-applied); only a file outside the room is a "custom" override.
        source: match ? "room" : "override-file",
        preview,
      },
      roomOptions,
      ambiguous: false,
      overridden: true,
    };
  }

  // No override — auto-derive from the room.
  const auto = matchRoomPersona(channel, roomOptions, room ?? undefined);
  if (auto) {
    return {
      channel,
      room,
      effective: { name: auto.name, path: auto.path, inline: null, source: "room", preview: auto.preview },
      roomOptions,
      ambiguous: false,
      overridden: false,
    };
  }

  return {
    channel,
    room,
    effective: null,
    roomOptions,
    ambiguous: roomOptions.length > 1,
    overridden: false,
  };
}

// ── Write side ───────────────────────────────────────────────────────────────

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Render a channel key as a TOML table key, quoting only when needed. */
function tomlChannelKey(key: string): string {
  return BARE_KEY_RE.test(key) ? key : `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The policy key a channel is stored under (case-insensitive match), or the channel itself. */
function policyKeyFor(policyPath: string, channel: string): string {
  if (!existsSync(policyPath)) return channel;
  const { channels } = loadPolicy(policyPath);
  return findChannelPolicy(channels, channel)?.key ?? channel;
}

/**
 * Edit the `[channels.<key>]` section of a policy file line-by-line, preserving
 * every comment and unrelated entry. `mutate` receives the section's body lines
 * (between the header and the next table header / EOF) and returns the new body.
 * Creates the section (appended) when it does not exist yet.
 */
function editChannelSection(
  policyPath: string,
  channelKey: string,
  mutate: (bodyLines: string[]) => string[],
): void {
  if (!existsSync(policyPath)) {
    const body = mutate([]).join("\n");
    writeFileSync(policyPath, `harbor_command = "harbor"\n\n[channels.${tomlChannelKey(channelKey)}]\n${body}\n`);
    return;
  }
  const text = readFileSync(policyPath, "utf8");
  const lines = text.split("\n");
  const headerRe = /^\s*\[channels\.(.+?)\]\s*$/;
  const unquote = (k: string) => (k.startsWith('"') && k.endsWith('"') ? k.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : k);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(headerRe);
    if (m && unquote(m[1]!.trim()).toLowerCase() === channelKey.toLowerCase()) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    // No section yet — append one.
    const body = mutate([]).join("\n");
    const sep = text.endsWith("\n") ? "" : "\n";
    appendFileSync(policyPath, `${sep}\n[channels.${tomlChannelKey(channelKey)}]\n${body}\n`);
    return;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  const newBody = mutate(body);
  const rebuilt = [...lines.slice(0, start + 1), ...newBody, ...lines.slice(end)];
  writeFileSync(policyPath, rebuilt.join("\n"));
}

/** Drop trailing blank lines from a section body so edits don't accrete gaps. */
function trimTrailingBlanks(body: string[]): string[] {
  const out = [...body];
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

/** Point a channel's persona at a file (a room persona or a custom file). */
export function setChannelPersonaFile(policyPath: string, channel: string, filePath: string): void {
  const key = policyKeyFor(policyPath, channel);
  editChannelSection(policyPath, key, (body) => {
    // Drop any existing persona/persona_file lines, then add the new pointer.
    const kept = body.filter((l) => !/^\s*persona(_file)?\s*=/.test(l));
    const cleaned = trimTrailingBlanks(kept);
    cleaned.push(`persona_file = "${filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    return cleaned;
  });
}

/** Remove any persona override from a channel (reverts to room-auto / none). */
export function removeChannelPersona(policyPath: string, channel: string): void {
  if (!existsSync(policyPath)) return;
  const key = policyKeyFor(policyPath, channel);
  editChannelSection(policyPath, key, (body) =>
    trimTrailingBlanks(body.filter((l) => !/^\s*persona(_file)?\s*=/.test(l))),
  );
}

/** Directory where custom (non-room) personas are stored. */
export function customPersonaDir(): string {
  return join(homedir(), ".buzz", "personas");
}

/** Write a custom persona body to `~/.buzz/personas/<channel>.md` and return its path. */
export function writeCustomPersona(channel: string, body: string): string {
  const slug = channel.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "channel";
  const path = join(customPersonaDir(), `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
  return path;
}

/**
 * Auto-apply a channel's room persona: when it has no override and the room
 * offers exactly one match, point `persona_file` at that live room file so
 * buzz-acp applies it — the "no import step" behavior. Returns what happened.
 */
export function syncChannelPersona(
  env: Environment,
  policyPath: string,
  channel: string,
): { channel: string; synced: boolean; path?: string; reason?: string } {
  const resolved = resolveChannelPersona(env, policyPath, channel);
  if (resolved.overridden) return { channel, synced: false, reason: "has an explicit override" };
  if (!resolved.effective || resolved.effective.source !== "room" || !resolved.effective.path) {
    return { channel, synced: false, reason: resolved.ambiguous ? "room has several personas — pick one" : "no room persona to apply" };
  }
  setChannelPersonaFile(policyPath, channel, resolved.effective.path);
  return { channel, synced: true, path: resolved.effective.path };
}
