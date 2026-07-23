/**
 * secrets.test.ts — keychain-backed secret storage + plaintext scanner.
 *
 * Soak-safe: the scanner tests run against fixture files in a mkdtemp dir, and
 * the store tests use an in-memory backend. No test reads or writes the live
 * machine's keychain.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  SecretError,
  backendFor,
  describeSecrets,
  exportLines,
  getSecret,
  isExpiredJwt,
  looksLikeSecret,
  removeSecret,
  scanConfigs,
  setSecret,
} from "./secrets.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** In-memory stand-in for the OS keychain. */
function memBackend() {
  const store = new Map<string, string>();
  return {
    name: "memory",
    store,
    async set(n: string, v: string) {
      store.set(n, v);
    },
    async get(n: string) {
      return store.get(n) ?? null;
    },
    async remove(n: string) {
      return store.delete(n);
    },
  };
}

function write(rel: string, body: string): string {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

describe("secret store", () => {
  test("round-trips a value and removes it", async () => {
    const b = memBackend();
    await setSecret("zapier-bearer", "s3cr3t-value-long-enough", b);
    expect(await getSecret("zapier-bearer", b)).toBe("s3cr3t-value-long-enough");
    expect(await removeSecret("zapier-bearer", b)).toBe(true);
    expect(await getSecret("zapier-bearer", b)).toBeNull();
    expect(await removeSecret("zapier-bearer", b)).toBe(false);
  });

  test("refuses an empty value or a blank name", async () => {
    const b = memBackend();
    await expect(setSecret("x", "", b)).rejects.toThrow(SecretError);
    await expect(setSecret("  ", "value", b)).rejects.toThrow(SecretError);
  });

  // The whole point of the module: a reporting path must never be able to
  // disclose a secret, even by accident.
  test("describeSecrets reports length and a 4-char prefix, never the value", async () => {
    const b = memBackend();
    await setSecret("tok", "abcdefghijklmnopqrstuvwxyz", b);
    const [info] = await describeSecrets(["tok", "absent"], b);
    expect(info).toEqual({ name: "tok", length: 26, prefix: "abcd" });
    expect(JSON.stringify(info)).not.toContain("efghij");
  });

  test("export lines resolve at shell run time, so they carry no secret", async () => {
    const lines = await exportLines(["zapier-mcp-bearer"], memBackend());
    expect(lines[0]).toBe('export ZAPIER_MCP_BEARER="$(harbor secrets get zapier-mcp-bearer 2>/dev/null)"');
    expect(lines[0]).toContain("harbor secrets get");
  });

  test("an unsupported platform errors rather than falling back to a file", () => {
    expect(() => backendFor("sunos")).toThrow(/does not fall back to a file/);
    expect(backendFor("darwin").name).toBe("macos-keychain");
    expect(backendFor("linux").name).toBe("libsecret");
  });
});

describe("looksLikeSecret", () => {
  test("classifies real credential shapes", () => {
    expect(looksLikeSecret("Authorization", "Bearer github_pat_11ABCDEFdummy0000")).toBe("github-pat");
    expect(looksLikeSecret("Authorization", "Bearer EXAMPLE-NOT-A-REAL-CREDENTIAL-0000")).toBe("bearer");
    expect(looksLikeSecret("API_KEY", "EXAMPLE0000NOT0000A0000REAL0000KEY00000")).toBe("api-key");
  });

  // A `${VAR}` reference is the END STATE this command migrates toward — it
  // must never be reported as a finding, or doctor would never converge.
  test("never flags a reference in ANY client dialect", () => {
    for (const ref of ["${ZAPIER_TOKEN}", "${env:ZAPIER_TOKEN}", "{env:ZAPIER_TOKEN}", "$ZAPIER_TOKEN"]) {
      expect(looksLikeSecret("Authorization", ref)).toBeNull();
      expect(looksLikeSecret("API_KEY", ref)).toBeNull();
    }
    expect(looksLikeSecret("Authorization", "Bearer ${ZAPIER_TOKEN}")).toBeNull();
  });

  // Both of these came from a live doctor run against real agent configs. A
  // scanner that reports non-secrets trains the operator to ignore it.
  test("does not flag credential-shaped KEYS that hold dates or identifiers", () => {
    expect(looksLikeSecret("claudeCodeFirstTokenDate", "2026-05-13T10:25:00.000Z")).toBeNull();
    expect(looksLikeSecret("experimentKey", "claude-code-some-experiment-name")).toBeNull();
    expect(looksLikeSecret("cacheKey", "abcdef0123456789abcdef0123456789")).toBeNull();
    // ...but a real key under a normal name is still caught.
    expect(looksLikeSecret("apiKey", "sk-or-v1-EXAMPLE0000NOTAREALKEY0000EXAMPLE")).toBe("api-key");
  });

  test("does not flag paths, URLs, or short values", () => {
    expect(looksLikeSecret("VAULT_PATH", "/Users/someone/Documents/Obsidian Vault")).toBeNull();
    expect(looksLikeSecret("SERVER_URL", "https://mcp.example.com/api/v1/connect")).toBeNull();
    expect(looksLikeSecret("Authorization", "Bearer short")).toBeNull();
    expect(looksLikeSecret("description", "a long human readable sentence value")).toBeNull();
  });
});

describe("isExpiredJwt", () => {
  /** Build an unsigned JWT with the given exp. Not a credential — a fixture. */
  function jwt(exp: number): string {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    return `${b64({ alg: "none" })}.${b64({ exp, iat: exp - 300 })}.sig`;
  }

  test("detects an expired token, with or without the Bearer prefix", () => {
    const past = 1_000_000_000;
    expect(isExpiredJwt(jwt(past))).toBe(true);
    expect(isExpiredJwt(`Bearer ${jwt(past)}`)).toBe(true);
  });

  test("a live token is not expired, and a non-JWT is never claimed to be", () => {
    const future = Date.now() / 1000 + 3600;
    expect(isExpiredJwt(jwt(future))).toBe(false);
    expect(isExpiredJwt("Bearer github_pat_11EXAMPLE")).toBe(false);
    expect(isExpiredJwt("not-a-token")).toBe(false);
  });
});

describe("scanConfigs", () => {
  test("finds a nested credential in JSON and reports its dotted location", () => {
    const p = write(
      "claude.json",
      JSON.stringify({
        mcpServers: {
          zapier: { headers: { Authorization: "Bearer EXAMPLE-FIXTURE-NOT-A-REAL-TOKEN" } },
          safe: { env: { AGENT_ENV_ROOM: "${AGENT_ENV_ROOM:-general}" } },
        },
      }),
    );
    const found = scanConfigs([p]);
    expect(found).toHaveLength(1);
    expect(found[0]!.location).toBe("mcpServers.zapier.headers.Authorization");
    expect(found[0]!.kind).toBe("bearer");
    // Never discloses more than a 4-char prefix.
    expect(found[0]!.prefix).toBe("Bear");
  });

  test("flags an EXPIRED jwt distinctly — it is inert and needs deleting, not migrating", () => {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const stale = `${b64({ alg: "none" })}.${b64({ exp: 1_000_000_000, iat: 999_999_700 })}.sig`;
    const p = write("x.json", JSON.stringify({ mcpServers: { a: { headers: { Authorization: `Bearer ${stale}` } } } }));
    const [f] = scanConfigs([p]);
    expect(f!.kind).toBe("jwt");
    expect(f!.expired).toBe(true);
  });

  test("scans non-JSON configs line-wise (YAML/TOML) without a parser dependency", () => {
    const p = write(
      "config.yaml",
      ["extensions:", "  github:", "    headers:", "      Authorization: Bearer github_pat_11ABCDEFdummy000", ""].join("\n"),
    );
    const found = scanConfigs([p]);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("github-pat");
    expect(found[0]!.location).toContain("line 4");
  });

  test("a fully migrated config yields no findings", () => {
    const p = write(
      "clean.json",
      JSON.stringify({
        mcpServers: {
          zapier: { headers: { Authorization: "Bearer ${ZAPIER_MCP_BEARER}" } },
          obsidian: { env: { OBSIDIAN_REST_API_KEY: "${OBSIDIAN_REST_API_KEY}", VAULT_PATH: "/Users/x/Vault" } },
        },
      }),
    );
    expect(scanConfigs([p])).toEqual([]);
  });

  test("missing and unreadable files are skipped, not fatal", () => {
    expect(scanConfigs([join(dir, "nope.json"), join(dir, "also-missing.yaml")])).toEqual([]);
  });
});

/**
 * Guard against the mistake this file itself made once: a credential fixture
 * pasted from a REAL config. A 36-character prefix of a live Zapier token
 * reached a public repo that way — harmless in the end (it decoded to part of
 * the account identifier, not the secret half) but entirely avoidable.
 *
 * Rule: any fixture shaped like a credential must SAY it is a fixture. Real
 * credentials do not contain the word EXAMPLE.
 */
describe("test fixtures are synthetic", () => {
  test("every literal this scanner would call a credential is marked as an example", async () => {
    const src = await Bun.file(new URL(import.meta.url)).text();
    const literals = src.match(/"[^"\n]{12,}"/g) ?? [];
    const unmarked = literals
      .map((l) => l.slice(1, -1))
      // Ask the scanner itself — no second, drifting notion of "looks secret".
      .filter((v) => looksLikeSecret("Authorization", v) !== null)
      .filter((v) => !/EXAMPLE|FIXTURE|NOTAREAL|NOT-A-REAL|dummy/i.test(v));
    expect(unmarked).toEqual([]);
  });
});
