/**
 * secrets.ts — Keychain-backed secret storage + a plaintext-credential scanner.
 *
 * Agent config files accumulate live credentials in plaintext. On the machine
 * that motivated this module, three files carried a Zapier bearer, an Obsidian
 * REST key, and a GitHub PAT — plus an `agent-cards` JWT that had expired
 * eleven days earlier and was still sitting on disk. Moving those into the OS
 * keychain and referencing them as `${VAR}` works, but done by hand it lives in
 * one machine's shell profile and is not reproducible. This makes it a command.
 *
 * TWO HARD RULES, both learned from real incidents:
 *
 *   1. A secret VALUE never passes through argv. `security add-generic-password
 *      -w <value>` puts the secret in the process table where any local process
 *      can read it via ps. {@link setSecret} pipes through stdin instead.
 *   2. No diagnostic ever prints a value. {@link listSecrets} and
 *      {@link scanConfigs} report name, length, and a 4-character prefix — never
 *      more. A previous `source <(grep …env)` leaked a token into a transcript;
 *      every reporting path here is built so that cannot happen.
 *
 * Backend is the OS keychain (macOS `security`, Linux `secret-tool`). There is
 * deliberately NO file fallback: silently writing secrets to disk is the exact
 * failure this module exists to end, and a loud error is the better outcome.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Keychain service all Harbor-managed secrets live under. */
export const SECRET_SERVICE = "harbor-managed";

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/** A secret, described WITHOUT disclosing it. */
export interface SecretInfo {
  name: string;
  length: number;
  /** First 4 characters — enough to correlate, useless as a credential. */
  prefix: string;
}

// ── Backend ──────────────────────────────────────────────────────────────────

interface Backend {
  readonly name: string;
  set(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  remove(name: string): Promise<boolean>;
}

/**
 * macOS keychain via `security`.
 *
 * The secret is delivered through `security -i` BATCH MODE, not argv: the value
 * is written on stdin as part of a command line that `security` parses inside
 * its own process, so it never appears in any process's argv (rule 1).
 *
 * A `-w <value>` argument would also work but exposes the value in argv. And
 * bare `-w` with a piped stdin — the ORIGINAL, BROKEN approach — does NOT read
 * stdin as the password: `security` treats stdin as the interactive
 * "type / retype password" prompt, a single value fails the retype, and it
 * stores NOTHING while still exiting 0. That silent-empty write is why
 * {@link setSecret} now reads the value back and refuses to report success
 * unless it round-trips.
 */
const macBackend: Backend = {
  name: "macos-keychain",
  async set(name, value) {
    if (value.includes("\n")) {
      throw new SecretError("secret value must not contain a newline (the keychain batch protocol is line-based)");
    }
    await run(["security", "delete-generic-password", "-a", name, "-s", SECRET_SERVICE], null, true);
    // The value rides on stdin inside the batch command, never in argv.
    const batch = `add-generic-password -a ${shellQuote(name)} -s ${SECRET_SERVICE} -U -w ${shellQuote(value)}\n`;
    const { code, stderr } = await run(["security", "-i"], batch);
    if (code !== 0) throw new SecretError(`keychain write failed: ${stderr.trim()}`);
  },
  async get(name) {
    const { code, stdout } = await run(
      ["security", "find-generic-password", "-a", name, "-s", SECRET_SERVICE, "-w"],
      null,
      true,
    );
    return code === 0 ? stdout.replace(/\n$/, "") : null;
  },
  async remove(name) {
    const { code } = await run(["security", "delete-generic-password", "-a", name, "-s", SECRET_SERVICE], null, true);
    return code === 0;
  },
};

/** Linux keychain via libsecret's `secret-tool`. */
const linuxBackend: Backend = {
  name: "libsecret",
  async set(name, value) {
    const { code, stderr } = await run(
      ["secret-tool", "store", "--label", `${SECRET_SERVICE}/${name}`, "service", SECRET_SERVICE, "account", name],
      value,
    );
    if (code !== 0) throw new SecretError(`secret-tool store failed: ${stderr.trim()}`);
  },
  async get(name) {
    const { code, stdout } = await run(
      ["secret-tool", "lookup", "service", SECRET_SERVICE, "account", name],
      null,
      true,
    );
    return code === 0 && stdout ? stdout.replace(/\n$/, "") : null;
  },
  async remove(name) {
    const { code } = await run(["secret-tool", "clear", "service", SECRET_SERVICE, "account", name], null, true);
    return code === 0;
  },
};

/**
 * Quote a value for a `security -i` batch command line. Its tokenizer honors
 * POSIX single-quoting; a literal single quote is written as the standard
 * `'\''` break-out. Verified against `security -i` with space- and
 * quote-bearing values before relying on it.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Resolve the backend for this platform, or explain why there isn't one. */
export function backendFor(plat: string = platform()): Backend {
  if (plat === "darwin") return macBackend;
  if (plat === "linux") return linuxBackend;
  throw new SecretError(
    `no OS keychain backend for platform '${plat}'. Harbor deliberately does not fall back to ` +
      `a file: storing secrets in plaintext is the problem this command exists to solve.`,
  );
}

async function run(
  cmd: string[],
  stdin: string | null,
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: stdin == null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Callers inspect `code` themselves; `allowFailure` documents which calls
  // treat a non-zero exit as an ordinary "not found" rather than an error.
  void allowFailure;
  return { code, stdout, stderr };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Store `value` under `name`, then READ IT BACK and confirm it round-trips.
 *
 * The read-back is not paranoia — the first implementation stored empty while
 * exiting 0 (see macBackend), so a "✓ stored 152 chars" message once meant a
 * secret that wasn't there. A store that cannot be read back as itself is a
 * failed store, and this reports it as one.
 */
export async function setSecret(name: string, value: string, backend = backendFor()): Promise<void> {
  if (!name.trim()) throw new SecretError("secret name is required");
  if (!value) throw new SecretError("refusing to store an empty secret");
  await backend.set(name, value);
  const readBack = await backend.get(name);
  if (readBack !== value) {
    throw new SecretError(
      `keychain write did not round-trip for '${name}' (stored ${value.length} chars, ` +
        `read back ${readBack?.length ?? "null"}). The secret was NOT saved.`,
    );
  }
}

/** Retrieve a secret, or null when it isn't stored. */
export async function getSecret(name: string, backend = backendFor()): Promise<string | null> {
  return backend.get(name);
}

/** Remove a secret. Returns false when it wasn't there. */
export async function removeSecret(name: string, backend = backendFor()): Promise<boolean> {
  return backend.remove(name);
}

/**
 * Describe the named secrets WITHOUT disclosing them. The OS keychain has no
 * portable "list by service" that is safe to shell out to, so callers pass the
 * names they care about (the CLI reads them from what {@link scanConfigs}
 * found, plus any explicitly given).
 */
export async function describeSecrets(names: string[], backend = backendFor()): Promise<SecretInfo[]> {
  const out: SecretInfo[] = [];
  for (const name of names) {
    const v = await backend.get(name);
    if (v != null) out.push({ name, length: v.length, prefix: v.slice(0, 4) });
  }
  return out;
}

// ── doctor: find plaintext credentials in agent configs ──────────────────────

/** A credential found sitting in plaintext in an agent's config file. */
export interface PlaintextFinding {
  /** Config file it was found in. */
  file: string;
  /** Dotted location inside the file, e.g. `mcpServers.zapier.headers.Authorization`. */
  location: string;
  length: number;
  prefix: string;
  /** Set when the value is a JWT whose `exp` has passed — it is already inert. */
  expired?: boolean;
  kind: "bearer" | "jwt" | "github-pat" | "api-key";
}

/**
 * Does this value look like a credential rather than a reference or a path?
 * A `${VAR}` / `{env:VAR}` reference is exactly what we're migrating TO, so it
 * is never a finding.
 */
export function looksLikeSecret(key: string, value: string): PlaintextFinding["kind"] | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  // Already a reference in any of the client dialects — the desired end state.
  const isReference = (s: string) => /^\$\{|^\{env:|^\$[A-Za-z_]/.test(s);
  if (isReference(v)) return null;
  if (/^Bearer\s+/i.test(v)) {
    const tok = v.replace(/^Bearer\s+/i, "");
    // `Bearer ${VAR}` is a migrated header, not a credential — the reference
    // sits AFTER the scheme, so it has to be re-checked here or doctor would
    // report its own successful migrations as findings and never converge.
    if (isReference(tok)) return null;
    if (/^gh[pousr]_|^github_pat_/.test(tok)) return "github-pat";
    if (/^eyJ[A-Za-z0-9_-]{10,}\./.test(tok)) return "jwt";
    return tok.length >= 20 ? "bearer" : null;
  }
  if (/^eyJ[A-Za-z0-9_-]{10,}\./.test(v)) return "jwt";
  if (/^gh[pousr]_|^github_pat_/.test(v)) return "github-pat";
  // A long opaque value under a credential-ish key. Paths and URLs are not it.
  if (/(TOKEN|KEY|SECRET|PASSWORD|PAT|CREDENTIAL)/i.test(key) && v.length >= 20 && !/^[/~]|^https?:/.test(v)) {
    // Substring matching on the key alone over-fires on real config in the
    // wild: `claudeCodeFirstTokenDate` holds a DATE, and `experimentKey` /
    // `cacheKey` hold identifiers. A scanner that cries wolf gets ignored, so
    // exclude the key shapes that are reliably not credentials, and any value
    // that parses as a timestamp.
    if (NON_CREDENTIAL_KEY.test(key)) return null;
    if (looksLikeTimestamp(v)) return null;
    return "api-key";
  }
  return null;
}

/**
 * Key shapes that contain a credential-ish word but reliably hold something
 * else: dates (`...TokenDate`, `...At`), and identifiers (`experimentKey`,
 * `cacheKey`, `sortKey`, `primaryKey`). Kept narrow on purpose — this suppresses
 * findings, so an over-broad entry here hides real secrets.
 */
const NON_CREDENTIAL_KEY = /(date$|time$|_at$|At$|experiment|cache|sort|primary|foreign|index|public)/i;

/** ISO-8601-ish or epoch-ms values that a credential-shaped key sometimes holds. */
function looksLikeTimestamp(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(v) || /^\d{13}$/.test(v);
}

/** True when `value` is a JWT whose `exp` claim is in the past. */
export function isExpiredJwt(value: string, nowSec: number = Date.now() / 1000): boolean {
  const tok = value.replace(/^Bearer\s+/i, "");
  const parts = tok.split(".");
  if (parts.length < 2 || !/^eyJ/.test(tok)) return false;
  try {
    let p = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    const claims = JSON.parse(atob(p)) as { exp?: number };
    return typeof claims.exp === "number" && claims.exp < nowSec;
  } catch {
    return false;
  }
}

/** Walk a parsed JSON config, reporting any plaintext credential. */
function walkJson(node: unknown, file: string, path: string[], out: PlaintextFinding[]): void {
  if (node == null || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === "string") {
      const kind = looksLikeSecret(k, v);
      if (kind) {
        const f: PlaintextFinding = {
          file,
          location: [...path, k].join("."),
          length: v.length,
          prefix: v.slice(0, 4),
          kind,
        };
        if (kind === "jwt" && isExpiredJwt(v)) f.expired = true;
        out.push(f);
      }
    } else {
      walkJson(v, file, [...path, k], out);
    }
  }
}

/**
 * Scan agent config files for plaintext credentials.
 *
 * `files` normally comes from the install registry (every agent's
 * `pathFromHome`), so a newly supported agent is scanned with no change here.
 * Non-JSON configs are scanned line-wise, which is enough for the YAML/TOML
 * agents without taking on a parser dependency.
 */
export function scanConfigs(files: string[]): PlaintextFinding[] {
  const out: PlaintextFinding[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (file.endsWith(".json")) {
      try {
        walkJson(JSON.parse(text), file, [], out);
        continue;
      } catch {
        // fall through to the line scan for malformed/JSONC files
      }
    }
    for (const [i, line] of text.split("\n").entries()) {
      const m = /^\s*(?:-\s*)?["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?(.+?)["']?\s*,?$/.exec(line);
      if (!m) continue;
      const [, key, value] = m as unknown as [string, string, string];
      const kind = looksLikeSecret(key, value);
      if (!kind) continue;
      const f: PlaintextFinding = {
        file,
        location: `${key} (line ${i + 1})`,
        length: value.length,
        prefix: value.slice(0, 4),
        kind,
      };
      if (kind === "jwt" && isExpiredJwt(value)) f.expired = true;
      out.push(f);
    }
  }
  return out;
}

/** Default home for resolving agent config paths. */
export function defaultHome(procEnv: Record<string, string | undefined> = process.env): string {
  return procEnv.HOME ?? procEnv.USERPROFILE ?? homedir();
}

/** Shell `export` lines for the given secrets, resolved from the keychain. */
export async function exportLines(names: string[], backend = backendFor()): Promise<string[]> {
  const lines: string[] = [];
  for (const name of names) {
    const envName = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    // The value is resolved at SHELL RUN TIME, not baked in here — so these
    // lines are safe to write into a dotfile or paste into a transcript.
    lines.push(
      `export ${envName}="$(harbor secrets get ${name} 2>/dev/null)"`,
    );
  }
  return lines;
}

/** Resolve an agent config path under `home`. */
export function configPath(home: string, segments: string[]): string {
  return join(home, ...segments);
}
