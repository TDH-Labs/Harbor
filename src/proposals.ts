/**
 * proposals.ts — Owner approval for skills that arrive through a shared folder.
 *
 * A skill installed into a room is delivered to everyone who holds a token for
 * that room, and to the house agent acting for them. So a skill written by a
 * low-privilege person and installed automatically would let that person put
 * instructions in front of higher-privilege readers. Nothing in Harbor installs
 * from a shared folder by itself and no MCP tool can — installing is an operator
 * command. This module is the safe way to do it by hand:
 *
 *   list / show   read a candidate; nothing is installed
 *   approve       install ONE candidate, only if its content is byte-for-byte what
 *                 the owner reviewed
 *
 * What "safe" means here:
 *   - Approval names a DIGEST of the content (every path and every byte). A
 *     folder that changes between the owner reading it and approving it fails the
 *     digest and installs nothing.
 *   - The bytes that were hashed are the bytes that are installed: each file is
 *     read once into memory, hashed, and written from that memory to a private
 *     staging directory; the pool is populated from staging, never from the
 *     shared folder, so there is no window in which a collaborator can swap a file.
 *   - A candidate containing a symlink or any non-regular file is refused: a link
 *     inside a skill would be copied into the pool and later served as skill text.
 *   - Binary files, oversized files, too many files, a missing SKILL.md and
 *     anything `harbor guard` would flag (credentials, secret-shaped filenames)
 *     make it unapprovable. Unreviewable content cannot be approved by review.
 *
 * What it does NOT do: judge whether a skill's instructions are wise or hostile.
 * That is the owner's read; the digest only guarantees they read what is installed.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { audit } from "./audit.ts";
import type { Environment } from "./env.ts";
import { scanFilename, scanText, type GuardFinding } from "./guard.ts";
import { isRealPathWithin } from "./sandbox.ts";
import { install, type InstallResult } from "./skill-install.ts";

export const MAX_PROPOSAL_FILES = 200;
export const MAX_PROPOSAL_FILE_BYTES = 512 * 1024;
export const MAX_PROPOSAL_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 8;
/** A skill's directory name. The first character rules out `.`-prefixed names and `__proto__`. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

export interface ProposalFile {
  /** Relative to the proposal, `/`-separated. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface Proposal {
  name: string;
  dir: string;
  description: string;
  files: ProposalFile[];
  totalBytes: number;
  /** sha256 over every path and file digest: what approval is bound to. */
  digest: string;
  /** Why it cannot be approved (empty = approvable). Never contains file content. */
  problems: string[];
  /** Credential findings, as `harbor guard` reports them (path, rule, line — never the secret). */
  findings: GuardFinding[];
}

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** A candidate's digest: order-independent over files, sensitive to every path and byte. */
export function digestOf(files: Array<Pick<ProposalFile, "path" | "sha256">>): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\0${f.sha256}\n`);
  }
  return h.digest("hex");
}

interface Read {
  proposal: Proposal;
  /** The exact bytes that were hashed, for staging. Empty when the candidate has problems. */
  contents: Map<string, Buffer>;
}

/**
 * Read one candidate directory ONCE: walk without following links, refuse what
 * cannot be reviewed, hash and keep the bytes.
 */
function readCandidate(dir: string, name: string): Read {
  const problems: string[] = [];
  const files: ProposalFile[] = [];
  const contents = new Map<string, Buffer>();
  const findings: GuardFinding[] = [];
  let total = 0;
  let truncated = false;

  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      problems.push(`nested deeper than ${MAX_DEPTH} levels: ${rel}`);
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      problems.push(`unreadable directory: ${rel || "."}`);
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = join(abs, e.name);
      if (e.isSymbolicLink()) {
        problems.push(`symlink: ${childRel}`);
      } else if (e.isDirectory()) {
        walk(childAbs, childRel, depth + 1);
      } else if (!e.isFile()) {
        problems.push(`not a regular file: ${childRel}`);
      } else {
        if (files.length >= MAX_PROPOSAL_FILES) {
          if (!truncated) problems.push(`more than ${MAX_PROPOSAL_FILES} files`);
          truncated = true;
          continue;
        }
        let size: number;
        try {
          size = lstatSync(childAbs).size;
        } catch {
          problems.push(`unreadable: ${childRel}`);
          continue;
        }
        if (size > MAX_PROPOSAL_FILE_BYTES || total + size > MAX_PROPOSAL_TOTAL_BYTES) {
          problems.push(size > MAX_PROPOSAL_FILE_BYTES ? `file over ${MAX_PROPOSAL_FILE_BYTES} bytes: ${childRel}` : `total over ${MAX_PROPOSAL_TOTAL_BYTES} bytes`);
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = readFileSync(childAbs);
        } catch {
          problems.push(`unreadable: ${childRel}`);
          continue;
        }
        // The read may have raced a growing file; trust the bytes, not the earlier stat.
        if (bytes.length > MAX_PROPOSAL_FILE_BYTES) {
          problems.push(`file over ${MAX_PROPOSAL_FILE_BYTES} bytes: ${childRel}`);
          continue;
        }
        total += bytes.length;
        if (bytes.includes(0)) problems.push(`binary file (cannot be reviewed): ${childRel}`);
        for (const rule of scanFilename(childRel)) findings.push({ path: childRel, kind: "filename", rule });
        if (!bytes.includes(0)) {
          for (const m of scanText(bytes.toString("utf8"))) findings.push({ path: childRel, kind: "content", rule: m.rule, line: m.line });
        }
        files.push({ path: childRel, bytes: bytes.length, sha256: sha256(bytes) });
        contents.set(childRel, bytes);
      }
    }
  };
  walk(dir, "", 0);

  const skillMd = contents.get("SKILL.md");
  if (!skillMd) problems.push("no SKILL.md at the top level");
  if (findings.length > 0) problems.push(`${findings.length} credential-shaped finding(s); run \`harbor guard\` on the folder`);

  const description = skillMd ? (skillMd.toString("utf8").match(/^description:\s*(.+)$/m)?.[1] ?? "").replace(/^["']|["']$/g, "").trim() : "";
  return {
    proposal: { name, dir, description, files, totalBytes: total, digest: digestOf(files), problems, findings },
    contents,
  };
}

/** The candidate directory under `inbox`, refusing a name or link that leaves it. */
function candidateDir(inbox: string, name: string): string {
  if (!NAME_RE.test(name) || name.includes("..")) throw new ProposalError(`invalid proposal name ${JSON.stringify(name)}`);
  const dir = join(inbox, name);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new ProposalError(`no proposal '${name}' in ${inbox}`);
  }
  if (st.isSymbolicLink()) throw new ProposalError(`'${name}' is a symlink; refusing to follow it`);
  if (!st.isDirectory()) throw new ProposalError(`'${name}' is not a directory`);
  if (!isRealPathWithin(dir, inbox)) throw new ProposalError(`'${name}' resolves outside the inbox`);
  return dir;
}

/** Read one candidate for review. Installs nothing. */
export function showProposal(inbox: string, name: string): { proposal: Proposal; contents: Map<string, string> } {
  const { proposal, contents } = readCandidate(candidateDir(inbox, name), name);
  return { proposal, contents: new Map([...contents].map(([p, b]) => [p, b.includes(0) ? "(binary)" : b.toString("utf8")])) };
}

/** Every directory in `inbox` that looks like a skill, with what would stop it being approved. */
export function listProposals(inbox: string): Proposal[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(inbox, { withFileTypes: true });
  } catch {
    throw new ProposalError(`cannot read inbox: ${inbox}`);
  }
  const out: Proposal[] = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue; // links and stray files are not candidates
    out.push(readCandidate(join(inbox, e.name), e.name).proposal);
  }
  return out;
}

export interface ApproveOptions {
  /** Where the skill goes. Required: an approval is always for a specific room. */
  room: string;
  /** The digest the owner reviewed (from `proposal list|show`). */
  digest: string;
  /** Recorded in the audit trail (default `operator`). */
  approvedBy?: string;
  /**
   * Test seam: runs after the candidate has been read and hashed and before it is
   * staged, so a test can rewrite the shared folder at the worst possible moment
   * and show the installed bytes are still the reviewed ones.
   */
  afterRead?: () => void;
}

/**
 * Install one candidate iff its content is exactly what was reviewed. Throws
 * {@link ProposalError} and installs nothing otherwise.
 */
export function approveProposal(env: Environment, inbox: string, name: string, options: ApproveOptions): InstallResult {
  if (!options.room) throw new ProposalError("a room is required");
  if (!/^[0-9a-f]{64}$/.test(options.digest)) throw new ProposalError("--digest must be the 64-hex-character digest from `proposal show`");

  const { proposal, contents } = readCandidate(candidateDir(inbox, name), name);
  if (proposal.problems.length > 0) {
    throw new ProposalError(`'${name}' cannot be approved:\n  - ${proposal.problems.join("\n  - ")}`);
  }
  if (proposal.digest !== options.digest) {
    throw new ProposalError(
      `'${name}' is not what was reviewed: its digest is ${proposal.digest}, not ${options.digest}. ` +
        "It changed after review (or you reviewed a different copy). Review it again with `proposal show`.",
    );
  }

  options.afterRead?.();

  // Install from private staging populated from the bytes just hashed — never
  // from the shared folder, which a collaborator can still write to.
  const staging = mkdtempSync(join(tmpdir(), "harbor-proposal-")); // mode 0700
  try {
    const root = join(staging, name);
    for (const [rel, bytes] of contents) {
      const dest = join(root, ...rel.split("/"));
      if (!dest.startsWith(root + sep)) throw new ProposalError(`unsafe path in proposal: ${rel}`); // unreachable: paths come from readdir
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes, { flag: "wx" });
    }
    const result = install(env, name, root, { room: options.room });
    audit.allow("cli", "skill_approve", name, `digest=${proposal.digest} room=${result.room} files=${proposal.files.length}`, {
      room: result.room,
      agentId: options.approvedBy ?? "operator",
      env,
    });
    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
