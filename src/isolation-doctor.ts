/**
 * isolation-doctor.ts — Report what stands between Harbor's cooperative room
 * gate and real, kernel-enforced isolation. REPORT ONLY: it changes nothing.
 *
 * docs/SPEC_hardening.md step 3 makes this the mandatory first move before any
 * permission change to the skill pool, for a blunt reason: a chmod on
 * `~/.agents/skills` that is wrong in either direction either locks the operator
 * out of their own skills or silently leaves the hole open. The dry run is how
 * you find out which — before it matters, not after.
 *
 * What it surfaces:
 *   1. The honest boundary — a room is currently a value the process asserts
 *      about itself (`AGENT_ENV_ROOM`), and the pool is readable by anything
 *      running as the operator. Neither is enforcement.
 *   2. Pool ownership + permissions on disk.
 *   3. Skills whose content implies HOST access (AppleScript, iMessage, desktop
 *      control): these cannot move into a Linux container and may break under a
 *      restricted uid — the reason "isolate everything" is the wrong plan here.
 *   4. A concrete, PRINTED-not-applied assessment for each room.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Environment } from "./env.ts";
import { findSkillDir } from "./skills.ts";

/** One skill flagged as needing host access it could not keep under isolation. */
export interface HostBoundSkill {
  name: string;
  room: string;
  /** The signals found in its SKILL.md (e.g. "osascript", "imessage"). */
  signals: string[];
}

export interface IsolationReport {
  /** Absolute pool path. */
  poolPath: string;
  poolExists: boolean;
  /** POSIX mode string of the pool dir, e.g. "755", or null when absent. */
  poolMode: string | null;
  /** True when the pool dir is readable by group or other (not just its owner). */
  poolWorldOrGroupReadable: boolean;
  /** Total skills in the pool. */
  totalSkills: number;
  /** Skills whose content implies host access (break under uid/container isolation). */
  hostBound: HostBoundSkill[];
  /** Configured rooms. */
  rooms: string[];
  /** Human-facing findings, most-important first. */
  findings: Finding[];
}

export interface Finding {
  severity: "info" | "warn";
  title: string;
  detail: string;
}

/**
 * Signals in a SKILL.md that mean the skill drives the HOST — AppleScript, the
 * desktop, native macOS apps. A skill like this cannot run in a Linux container
 * and may lose access under a restricted uid (TCC grants are per-user). Kept
 * as word-boundary patterns so "computer-use" matches but "recompute" does not.
 */
const HOST_ACCESS_SIGNALS: Array<[string, RegExp]> = [
  ["osascript", /\bosascript\b/i],
  ["AppleScript", /\bapplescript\b/i],
  ["iMessage", /\bimessage\b|\bimsg\b/i],
  // The `memo` and `remindctl` CLIs drive Apple Notes / Reminders — but ONLY in
  // command position. Bare "memo" is the word every legal and finance skill
  // uses for a document ("draft a memo"), and matching it flagged 50+
  // pure-text skills as host-bound. Require an actual invocation.
  [
    "Apple Notes/Reminders",
    /\bapple[- ]?(notes|reminders)\b|\bremindctl\b|\bmemo (create|search|edit|list|new|add|delete)\b|`memo`|\bmemo (CLI|--)/i,
  ],
  ["desktop control", /\bcomputer[- ]?use\b|\bcomputercontroller\b|\bpeekaboo\b|\bscreenshot\b/i],
  ["Safari/GUI", /\bosascript.*safari\b|\btell app\b/i],
  ["voice/audio", /\bafplay\b|\bedge[- ]?tts\b|\bsay\b -v/i],
];

/** Scan one skill's SKILL.md for host-access signals. */
function hostSignals(skillMd: string): string[] {
  const found: string[] = [];
  for (const [label, re] of HOST_ACCESS_SIGNALS) {
    if (re.test(skillMd)) found.push(label);
  }
  return found;
}

/** POSIX mode of a path as an octal string (owner/group/other), or null. */
function modeOf(path: string): string | null {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    return null;
  }
}

/**
 * Analyze the current isolation posture. Read-only: opens files, changes none.
 */
export function analyzeIsolation(env: Environment): IsolationReport {
  const poolPath = env.skillsDir;
  const poolExists = existsSync(poolPath);
  const poolMode = poolExists ? modeOf(poolPath) : null;
  // group-readable (0o040) or other-readable (0o004) — i.e. not owner-only.
  const modeNum = poolMode ? parseInt(poolMode, 8) : 0;
  const poolWorldOrGroupReadable = (modeNum & 0o044) !== 0;

  const rooms = Object.keys(env.config.roomSkills);

  // Reverse a skill → its configured room(s) for labeling. A skill in no room
  // is reported under "(unassigned)".
  const skillRoom = new Map<string, string>();
  for (const room of rooms) {
    for (const skill of env.config.roomSkillSet(room)) {
      if (!skillRoom.has(skill)) skillRoom.set(skill, room);
    }
  }

  const hostBound: HostBoundSkill[] = [];
  let totalSkills = 0;
  if (poolExists) {
    for (const entry of safeReaddir(poolPath)) {
      const dir = findSkillDir(env, entry) ?? join(poolPath, entry);
      const md = join(dir, "SKILL.md");
      if (!existsSync(md)) continue;
      totalSkills++;
      let text = "";
      try {
        text = readFileSync(md, "utf8");
      } catch {
        continue;
      }
      const signals = hostSignals(text);
      if (signals.length > 0) {
        hostBound.push({ name: entry, room: skillRoom.get(entry) ?? "(unassigned)", signals });
      }
    }
  }
  hostBound.sort((a, b) => a.name.localeCompare(b.name));

  const findings: Finding[] = [];

  // 1. The honest boundary — always true today, stated first.
  findings.push({
    severity: "warn",
    title: "Room is self-asserted, not enforced",
    detail:
      "A session's room comes from AGENT_ENV_ROOM, which the agent process sets for itself. " +
      "Any process that can set an env var can pick its own room. This is cooperative, " +
      "tool-level gating — real enforcement needs the room decided somewhere the agent cannot reach.",
  });

  // 2. Pool readability.
  if (poolExists && poolWorldOrGroupReadable) {
    findings.push({
      severity: "warn",
      title: `Skill pool is readable beyond its owner (mode ${poolMode})`,
      detail:
        `${poolPath} can be read by group/other. Even with the MCP gate, any local process can ` +
        "read a SKILL.md directly and skip Harbor entirely. Owner-only (700) is the floor; a " +
        "dedicated pool uid is the real fix (see docs/SPEC_hardening.md step 3).",
    });
  } else if (poolExists) {
    findings.push({
      severity: "info",
      title: `Skill pool is owner-only (mode ${poolMode})`,
      detail:
        "Good, but on a single-user machine the agents run AS the owner, so owner-only perms do " +
        "not separate an agent from the pool. Kernel enforcement still needs a distinct uid.",
    });
  }

  // 3. Host-bound skills — the reason "containerize everything" is wrong here.
  if (hostBound.length > 0) {
    findings.push({
      severity: "info",
      title: `${hostBound.length} skill(s) require host access`,
      detail:
        "These drive AppleScript / the desktop / native macOS apps. They cannot run in a Linux " +
        "container and may break under a restricted uid (TCC is per-user). Isolate the rooms that " +
        "need no host access first; leave these where they are.",
    });
  }

  return {
    poolPath,
    poolExists,
    poolMode,
    poolWorldOrGroupReadable,
    totalSkills,
    hostBound,
    rooms,
    findings,
  };
}

/** readdir that yields [] instead of throwing on a missing/denied dir. */
function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Render a report as human-facing text for `harbor isolation doctor`. */
export function formatReport(r: IsolationReport): string {
  const lines: string[] = [];
  lines.push("Harbor isolation posture — REPORT ONLY, nothing was changed.");
  lines.push("");
  lines.push(`Skill pool: ${r.poolPath}`);
  lines.push(
    r.poolExists
      ? `  exists · mode ${r.poolMode} · ${r.totalSkills} skill(s) · ${r.rooms.length} room(s)`
      : "  (does not exist yet)",
  );
  lines.push("");
  for (const f of r.findings) {
    lines.push(`${f.severity === "warn" ? "⚠️ " : "•  "}${f.title}`);
    for (const seg of wrap(f.detail, 76)) lines.push(`     ${seg}`);
    lines.push("");
  }
  if (r.hostBound.length > 0) {
    lines.push("Host-bound skills (keep out of container/uid isolation):");
    for (const s of r.hostBound) {
      lines.push(`  ${s.name.padEnd(28)} [${s.room}]  ${s.signals.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("Next: pick ONE room that needs no host access (research / devops) and");
  lines.push("isolate it end to end before touching any other. Do not roll wholesale.");
  return lines.join("\n");
}

/** Minimal word-wrap for the detail paragraphs. */
function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      out.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line);
  return out;
}
