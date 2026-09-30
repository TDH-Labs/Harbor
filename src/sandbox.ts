/**
 * sandbox.ts — Symlink-safe room path containment (`RoomPathSandbox`).
 *
 * `path-safety.ts#isPathWithin` is LEXICAL: it normalizes `..` with
 * `path.resolve` and never touches the filesystem, so it says "inside" for a
 * symlink under the room that points at another room, and for `link/../x`
 * where the kernel would follow `link` before applying `..`. This module is the
 * filesystem-aware replacement for room boundaries:
 *
 *     realpath(P) ⊆ realpath(RoomRoot)
 *
 * {@link realpathLoose} resolves a path segment by segment the way the kernel
 * does — following each symlink it meets and applying `..` to the RESOLVED
 * path — so neither trick escapes. A tail that does not exist yet (a file about
 * to be created) is appended lexically, which makes "may I write here?"
 * answerable before the file exists. Every failure path denies.
 *
 * Honest scope: this is a path check. It does not close a check-then-use race
 * (a symlink swapped between the check and the open) or a hard link into the
 * room; both need OS-level confinement. Use {@link RoomPathSandbox.resolve}'s
 * returned real path for the subsequent open to keep that window small.
 *
 * Room names are validated before they are ever joined into a path: a room
 * named `..` would otherwise make the "room root" the whole environment.
 */
import { lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

/** Every violation message starts with this, so logs and agents can key on it. */
export const ROOM_JAIL_PREFIX = "HARBOR ROOM JAIL VIOLATION";

const ROOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Kernel-style symlink hop ceiling (Linux MAXSYMLINKS is 40). */
const MAX_SYMLINK_HOPS = 40;

/** Is `room` safe to use as a single path segment? */
export function isValidRoomName(room: string): boolean {
  return ROOM_NAME_RE.test(room) && !room.includes("..");
}

/** Thrown when a path resolves outside its room (or the room name itself is unsafe). */
export class RoomJailViolation extends Error {
  readonly path: string;
  readonly room: string;
  readonly roots: readonly string[];
  readonly reason: string;
  constructor(init: { path: string; room: string; roots: readonly string[]; reason: string }) {
    super(`${ROOM_JAIL_PREFIX}: ${init.reason} (room '${init.room}', path '${init.path}')`);
    this.name = "RoomJailViolation";
    this.path = init.path;
    this.room = init.room;
    this.roots = init.roots;
    this.reason = init.reason;
  }
}

function splitSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
}

/** Append `rest` to `base` lexically (no filesystem access), honoring `..`. */
function appendLexical(base: string, rest: string[]): string {
  let current = base;
  for (const seg of rest) {
    if (seg === "." || seg === "") continue;
    current = seg === ".." ? dirname(current) : join(current, seg);
  }
  return current;
}

/**
 * Resolve `input` to an absolute path with every EXISTING symlink followed and
 * `..` applied to the resolved path (POSIX semantics). A non-existent tail is
 * appended lexically. Relative inputs resolve against `cwd`.
 *
 * Throws on a NUL byte or a symlink loop; callers that want a boolean use
 * {@link isRealPathWithin}, which treats a throw as "outside".
 */
export function realpathLoose(input: string, cwd: string = process.cwd()): string {
  if (input.includes("\0")) throw new Error("path contains a NUL byte");
  const full = isAbsolute(input) ? input : cwd + sep + input;
  const { root } = parse(full);
  const queue = splitSegments(full.slice(root.length));
  let current = root;
  let hops = 0;

  while (queue.length > 0) {
    const seg = queue.shift() as string;
    if (seg === ".") continue;
    if (seg === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, seg);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      // Missing (or unreadable) — nothing below it can be a symlink we could
      // follow, so the remainder is purely lexical.
      return appendLexical(next, queue);
    }
    if (!isLink) {
      current = next;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) {
      throw new Error(`too many levels of symbolic links resolving '${input}'`);
    }
    const target = readlinkSync(next);
    if (isAbsolute(target)) {
      const targetRoot = parse(target).root;
      current = targetRoot;
      queue.unshift(...splitSegments(target.slice(targetRoot.length)));
    } else {
      // Relative target: resolved from the directory holding the link, which is
      // `current` (the link itself was not appended).
      queue.unshift(...splitSegments(target));
    }
  }
  return current;
}

/** True iff `candidate` (already real) equals `root` (already real) or is inside it. */
function realWithin(realCandidate: string, realRoot: string): boolean {
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realCandidate === realRoot || realCandidate.startsWith(prefix);
}

/**
 * Filesystem-aware containment: does `candidate` resolve, symlinks included,
 * to `root` itself or somewhere inside it? Any resolution error → false.
 */
export function isRealPathWithin(candidate: string, root: string, cwd?: string): boolean {
  try {
    const base = cwd ?? process.cwd();
    return realWithin(realpathLoose(candidate, base), realpathLoose(root, base));
  } catch {
    return false;
  }
}

/** Outcome of {@link RoomPathSandbox.check}. */
export type SandboxCheck = { ok: true; real: string } | { ok: false; reason: string };

export interface RoomPathSandboxInit {
  room: string;
  /** Absolute room roots; the first is the primary root (default cwd). */
  roots: readonly string[];
}

/**
 * A room's set of allowed roots plus the checks that enforce them. Roots are
 * re-resolved on every call, so a symlink introduced after construction is
 * still seen.
 */
export class RoomPathSandbox {
  readonly room: string;
  readonly roots: readonly string[];

  constructor(init: RoomPathSandboxInit) {
    // Absolutized once so a relative root cannot drift with the process cwd.
    const roots = init.roots.filter((r) => r !== "").map((r) => resolve(r));
    if (!isValidRoomName(init.room)) {
      throw new RoomJailViolation({
        path: "",
        room: init.room,
        roots,
        reason: "invalid room name",
      });
    }
    if (roots.length === 0) {
      throw new RoomJailViolation({ path: "", room: init.room, roots, reason: "no room roots configured" });
    }
    this.room = init.room;
    this.roots = roots;
  }

  /** The primary root: where relative paths and child processes are anchored. */
  get primaryRoot(): string {
    return this.roots[0] as string;
  }

  /**
   * Resolve `path` and report whether it lies inside any root. Relative paths
   * resolve against `cwd` (default: the primary root, so a bare `notes.md`
   * means "in this room").
   */
  check(path: string, cwd?: string): SandboxCheck {
    if (path === "") return { ok: false, reason: "empty path" };
    let real: string;
    try {
      real = realpathLoose(path, cwd ?? this.primaryRoot);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "unresolvable path" };
    }
    for (const root of this.roots) {
      let realRoot: string;
      try {
        realRoot = realpathLoose(root, cwd ?? this.primaryRoot);
      } catch {
        continue;
      }
      if (realWithin(real, realRoot)) return { ok: true, real };
    }
    return { ok: false, reason: "path resolves outside the room" };
  }

  contains(path: string, cwd?: string): boolean {
    return this.check(path, cwd).ok;
  }

  /** The real path, or {@link RoomJailViolation}. Open the RETURNED path. */
  resolve(path: string, cwd?: string): string {
    const r = this.check(path, cwd);
    if (r.ok) return r.real;
    throw new RoomJailViolation({ path, room: this.room, roots: this.roots, reason: r.reason });
  }

  /**
   * The working directory for a confined child process: the primary root when
   * `requested` is absent, otherwise `requested` after it passes {@link resolve}.
   * The primary root is created if it does not exist yet.
   */
  resolveCwd(requested?: string): string {
    if (requested === undefined || requested === "") {
      mkdirSync(this.primaryRoot, { recursive: true });
      return this.resolve(this.primaryRoot);
    }
    return this.resolve(requested);
  }
}

/** Which family of room roots to build. */
export type RoomRootKind = "files" | "data";

/**
 * The roots a room may touch under `base` (an Environment root):
 *  - `files`: `rooms/<room>` (the room itself) and `workspace/<room>`
 *  - `data`:  `data/<room>`
 */
export function roomRoots(base: string, room: string, kind: RoomRootKind = "files"): string[] {
  return kind === "data"
    ? [join(base, "data", room)]
    : [join(base, "rooms", room), join(base, "workspace", room)];
}

/**
 * Build the sandbox for `room` under `base`. Throws {@link RoomJailViolation}
 * for an unsafe room name.
 */
export function createRoomSandbox(base: string, room: string, kind: RoomRootKind = "files"): RoomPathSandbox {
  if (!isValidRoomName(room)) {
    throw new RoomJailViolation({ path: "", room, roots: [], reason: "invalid room name" });
  }
  return new RoomPathSandbox({ room, roots: roomRoots(base, room, kind) });
}
