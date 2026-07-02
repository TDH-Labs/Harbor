/**
 * path-safety.ts — The one containment check every room/pool boundary in
 * this codebase enforces with.
 *
 * Previously duplicated: isolation.ts had a `sep`-aware version, skills.ts
 * had an independently-written copy that hardcoded `/` (correct on
 * macOS/Linux, silently wrong on Windows). Two copies of a security check are
 * a liability — a future fix to one is not a fix to the other. This is the
 * single source of truth; both callers import it.
 */
import { resolve, sep } from "node:path";

/**
 * True iff `candidate` (already absolute, or resolved relative to cwd)
 * resolves to `root` itself or somewhere strictly inside it. Both sides are
 * re-resolved LEXICALLY (`path.resolve`, not `fs.realpath`) so a
 * caller-supplied `..` segment can't walk the check out of the room (the bug
 * this replaces: a plain string `startsWith`/`slice` prefix check accepted
 * unnormalized paths like `workspace/<room>/../<other-room>/secret.md`,
 * which strips to a string that *starts with* the allowed prefix while
 * actually resolving outside it).
 *
 * Scope, stated precisely so this isn't over-read: this closes the `..`
 * class only. A *symlink* inside the checked directory pointing elsewhere
 * still resolves as "within" here, since lexical resolution never touches
 * the filesystem — this is cooperative, tool-level enforcement, not OS-level
 * isolation.
 */
export function isPathWithin(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}
