/**
 * guard.ts — Scan a folder for credentials and never-sync files BEFORE it is
 * shared (synced to a drive, published, zipped for a teammate).
 *
 * The rule this enforces: no secret ever enters a shared tree. Harbor's gates
 * govern what an agent may fetch THROUGH Harbor; they cannot see a key someone
 * pasted into a note that a whole team's laptops then sync. This is the check
 * that runs on the folder itself.
 *
 * Properties that matter more than the rule list:
 *  - It NEVER reports content. A finding is `(path, kind, rule, line)`. A
 *    scanner whose output contains the secret has just made a second copy of it
 *    in a log.
 *  - It does not follow symlinks. A symlink in a shared tree is itself a finding
 *    (it points somewhere the tree's permissions do not cover), and following one
 *    could walk out of the folder being checked or loop.
 *  - Anything it cannot inspect (too large, binary, unreadable, outside the root)
 *    is REPORTED as skipped, never silently passed.
 *  - Path lists are confined: a `files` list naming `../../etc/passwd` is refused,
 *    not read.
 *
 * Honest limits: pattern matching finds credentials that look like credentials.
 * A password in a sentence, or a token in an unknown format, will pass. Treat a
 * clean result as "nothing obvious", not "safe". Filename rules for words like
 * `token` and `secret` are deliberately blunt (they will flag a note called
 * `token-budget.md`); exempt known-good paths with `allow`.
 */
import { lstatSync, openSync, closeSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

import { isRealPathWithin } from "./sandbox.ts";

export type GuardKind = "filename" | "content" | "symlink";

export interface GuardFinding {
  /** Path relative to the scanned root, `/`-separated. */
  path: string;
  kind: GuardKind;
  /** Which rule fired. Never the matched text. */
  rule: string;
  /** 1-based line of the first match, for content findings. */
  line?: number;
}

export type GuardSkipReason = "too-large" | "binary" | "unreadable" | "outside-root" | "not-found";

export interface GuardSkip {
  path: string;
  reason: GuardSkipReason;
}

export interface GuardReport {
  root: string;
  /** Files whose content was inspected. */
  scanned: number;
  findings: GuardFinding[];
  /** Things that could not be inspected. Not a pass: see `strict`. */
  skipped: GuardSkip[];
  /** Entries skipped by the exclude list (e.g. `.git`). */
  excluded: number;
}

export interface GuardOptions {
  /** Glob patterns (relative paths; `*` within a segment, `**` across) exempt from findings. */
  allow?: string[];
  /** Files larger than this are skipped, not scanned (default 5 MiB). */
  maxBytes?: number;
  /** Directory/file NAMES never entered (default `.git`, `node_modules`). */
  exclude?: string[];
  /** Scan exactly these paths (relative to `root`) instead of walking the tree. */
  files?: string[];
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_EXCLUDE: readonly string[] = [".git", "node_modules"];

// ── Filename rules ───────────────────────────────────────────────────────────

interface FilenameRule {
  rule: string;
  test: (base: string, segments: string[]) => boolean;
}

const FILENAME_RULES: FilenameRule[] = [
  { rule: "private-key-file", test: (b) => /\.(pem|key|p12|pfx)$/i.test(b) },
  { rule: "vault-file", test: (b) => /\.vault$/i.test(b) },
  { rule: "dotenv-file", test: (b) => /^\.env(\..*)?$/i.test(b) },
  { rule: "ssh-key-file", test: (b) => /^id_(rsa|dsa|ecdsa|ed25519)/i.test(b) && !/\.pub$/i.test(b) },
  { rule: "harbor-config", test: (b) => b.toLowerCase() === "config.toml" },
  { rule: "credentials-name", test: (b) => /credentials/i.test(b) },
  { rule: "secret-name", test: (b) => /secret/i.test(b) },
  { rule: "token-name", test: (b) => /token/i.test(b) },
  { rule: "private-name", test: (b) => /private/i.test(b) },
  { rule: "secret-directory", test: (_b, segs) => segs.slice(0, -1).some((s) => /^(vault|secrets)$/i.test(s)) },
  // Not a credential, but never something to share: Harbor's own audit log,
  // budgets and sessions (SQLite files must not be synced either — a half-copied
  // WAL corrupts them).
  {
    rule: "harbor-state",
    test: (b, segs) => /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i.test(b) || segs.slice(0, -1).includes(".agent-env"),
  },
];

/** Which filename rules a relative path trips. */
export function scanFilename(relPath: string): string[] {
  const segments = relPath.split("/").filter(Boolean);
  const base = segments.at(-1) ?? "";
  return FILENAME_RULES.filter((r) => r.test(base, segments)).map((r) => r.rule);
}

// ── Content rules ────────────────────────────────────────────────────────────

/** Shannon entropy of `s`, in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER = /^(?:\$|\{|<|%|\*+$)|changeme|placeholder|example|your[_-]|xxxx|redacted|dummy|sample/i;

/**
 * A matched TOKEN that spells out that it is fake. Applied to the token itself
 * (never the surrounding line): real credentials are random, and do not contain
 * "EXAMPLE". This also covers the well-known documentation keys (AWS's ends in
 * EXAMPLE) that turn up in every README.
 */
const FAKE_TOKEN = /example|dummy|not-?a-?real|placeholder|redacted|fake|xxxx|0000000/i;
const notFake = (m: RegExpExecArray): boolean => !FAKE_TOKEN.test(m[0]);

/** Something a programmer wrote (`made.token.slice`, `getPasswordFromVault`, `db_password_field`), not a secret. */
function looksLikeIdentifier(v: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(v) || // a.b.c
    /^[a-z]+(?:[A-Z][a-z0-9]+)+$/.test(v) || // camelCase
    /^[A-Za-z]+(?:_[A-Za-z0-9]+)+$/.test(v) // snake_case words
  );
}

/** A value that is plainly a reference or a stand-in, not a credential. */
function looksLikePlaceholder(v: string): boolean {
  if (PLACEHOLDER.test(v)) return true;
  if (new Set(v).size <= 3) return true; // "aaaaaaaaaaaaaaaa", "1212121212121212"
  return false;
}

interface LineRule {
  rule: string;
  re: RegExp;
  /** Extra check on the (first) capture group or whole match; false = ignore this hit. */
  accept?: (match: RegExpExecArray) => boolean;
}

const LINE_RULES: LineRule[] = [
  { rule: "private-key-block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, accept: notFake },
  { rule: "openai-style-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, accept: notFake },
  { rule: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, accept: notFake },
  { rule: "aws-secret-key", re: /aws_secret_access_key\s*[:=]\s*\S+/i },
  { rule: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, accept: notFake },
  { rule: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/, accept: notFake },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, accept: notFake },
  { rule: "gcp-service-account", re: /"type"\s*:\s*"service_account"/ },
  { rule: "npm-auth-token", re: /_authToken\s*=\s*\S+/ },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/, accept: notFake },
  { rule: "harbor-token", re: /\bhbr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}\b/, accept: notFake },
  {
    rule: "credential-assignment",
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["']?([A-Za-z0-9+/_=.-]{16,})/i,
    accept: (m) => {
      const v = m[1] as string;
      return !looksLikePlaceholder(v) && !looksLikeIdentifier(v) && shannonEntropy(v) >= 3.0;
    },
  },
  {
    rule: "high-entropy-blob",
    re: /[A-Za-z0-9+/_=-]{64,}/,
    accept: (m) => {
      const v = m[0];
      if (/^[0-9a-fA-F]+$/.test(v)) return false; // a bare hash/checksum, not a secret by itself
      // A subresource-integrity hash (lockfiles): `sha512-<base64>` is public by design.
      // ('-' is in the character class, so the match usually STARTS with the prefix.)
      if (/^sha(?:1|256|384|512)-/i.test(v)) return false;
      if (/sha(?:1|256|384|512)-$/i.test(m.input.slice(Math.max(0, m.index - 8), m.index))) return false;
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((c) => c.test(v)).length;
      return classes >= 2 && shannonEntropy(v) >= 4.5;
    },
  },
];

/** Which content rules a block of text trips, with the first line of each. Never returns the text. */
export function scanText(text: string): Array<{ rule: string; line: number }> {
  const hits = new Map<string, number>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    for (const r of LINE_RULES) {
      if (hits.has(r.rule)) continue;
      // Global scan of the line so a rejected first match does not hide a later real one.
      const re = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (!r.accept || r.accept(m)) {
          hits.set(r.rule, i + 1);
          break;
        }
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  return [...hits].map(([rule, line]) => ({ rule, line }));
}

// ── Allow globs ──────────────────────────────────────────────────────────────

/** `*` matches within one path segment, `**` across segments, `?` one non-slash char. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero directories
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// ── The scan ─────────────────────────────────────────────────────────────────

/** Read at most `n` bytes from the start of a file. */
function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan `root`. Never throws on an unreadable entry (it is reported as skipped);
 * throws only if `root` itself is not a directory.
 */
export function scanTree(root: string, options: GuardOptions = {}): GuardReport {
  const st = statSync(root); // throws ENOENT for a missing root — the caller's error
  if (!st.isDirectory()) throw new Error(`not a directory: ${root}`);

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const exclude = new Set(options.exclude ?? DEFAULT_EXCLUDE);
  const allow = (options.allow ?? []).map(globToRegExp);
  const isAllowed = (rel: string): boolean => allow.some((re) => re.test(rel));

  const report: GuardReport = { root, scanned: 0, findings: [], skipped: [], excluded: 0 };

  const inspect = (rel: string): void => {
    const abs = join(root, ...rel.split("/"));
    let info;
    try {
      info = lstatSync(abs);
    } catch {
      report.skipped.push({ path: rel, reason: "not-found" });
      return;
    }
    if (isAllowed(rel)) return;

    if (info.isSymbolicLink()) {
      report.findings.push({ path: rel, kind: "symlink", rule: "symlink" });
      return; // never followed
    }
    if (!info.isFile()) return; // sockets, fifos, devices: nothing to read

    for (const rule of scanFilename(rel)) report.findings.push({ path: rel, kind: "filename", rule });

    if (info.size > maxBytes) {
      report.skipped.push({ path: rel, reason: "too-large" });
      return;
    }
    let data: Buffer;
    try {
      data = info.size === 0 ? Buffer.alloc(0) : readHead(abs, Math.min(info.size, maxBytes));
    } catch {
      report.skipped.push({ path: rel, reason: "unreadable" });
      return;
    }
    if (data.subarray(0, 8000).includes(0)) {
      report.skipped.push({ path: rel, reason: "binary" });
      return;
    }
    report.scanned++;
    for (const hit of scanText(data.toString("utf8"))) {
      report.findings.push({ path: rel, kind: "content", rule: hit.rule, line: hit.line });
    }
  };

  if (options.files) {
    for (const raw of options.files) {
      const rel = raw.trim().replace(/^\.\//, "");
      if (!rel) continue;
      // A path list is untrusted input. Its DIRECTORY chain must resolve inside the
      // root, symlinks included (`linkdir/file` where linkdir points out is refused,
      // as are `../../etc/passwd` and absolute paths). The final component is then
      // lstat'ed by inspect(), so a symlink there is reported as a symlink, not read.
      if (
        isAbsolute(rel) ||
        rel.split(/[\\/]/).includes("..") ||
        !isRealPathWithin(join(root, dirname(rel)), root)
      ) {
        report.skipped.push({ path: rel, reason: "outside-root" });
        continue;
      }
      inspect(rel.split(sep).join("/"));
    }
  } else {
    const stack: string[] = [""];
    while (stack.length > 0) {
      const dirRel = stack.pop() as string;
      let entries;
      try {
        entries = readdirSync(join(root, dirRel), { withFileTypes: true });
      } catch {
        report.skipped.push({ path: dirRel || ".", reason: "unreadable" });
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (exclude.has(e.name)) {
          report.excluded++;
          continue;
        }
        if (e.isDirectory()) stack.push(rel);
        else inspect(rel);
      }
    }
  }

  report.findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0)));
  report.skipped.sort((a, b) => (a.path < b.path ? -1 : 1));
  return report;
}

/** Did the scan pass? `strict` also fails on anything it could not inspect. */
export function guardPassed(report: GuardReport, strict = false): boolean {
  return report.findings.length === 0 && (!strict || report.skipped.length === 0);
}
