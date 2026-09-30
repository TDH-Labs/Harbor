/**
 * guard.test.ts — the pre-sync secret scanner.
 *
 * Every fake credential here is ASSEMBLED AT RUNTIME from fragments, never
 * written as a literal: a test file full of realistic-looking keys is exactly
 * what a repository's push protection (and our own guard) is built to refuse.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globToRegExp, guardPassed, scanFilename, scanText, scanTree, shannonEntropy, type GuardFinding } from "./guard.ts";

// ── fake credentials, built from parts ───────────────────────────────────────
// mulberry32: a small, well-mixed seeded PRNG (an LCG mod 65 has awful low bits and
// produced near-constant "secrets" — entropy 0.18 — which tests nothing).
const rnd = (n: number, alphabet: string, seed = 7): string => {
  let a = seed | 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
};
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B64 = ALNUM + "+/";
const fake = {
  privateKey: () => ["-----BEGIN", "RSA PRIVATE", "KEY-----"].join(" "),
  anthropic: () => "sk" + "-ant-" + rnd(40, ALNUM, 1),
  openai: () => "sk" + "-" + rnd(48, ALNUM, 2),
  awsId: () => "AK" + "IA" + rnd(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 3),
  awsSecretLine: () => "aws_secret" + "_access_key = " + rnd(40, B64, 4),
  slack: () => "xo" + "xb-" + rnd(12, "0123456789", 5) + "-" + rnd(24, ALNUM, 5),
  github: () => "gh" + "p_" + rnd(36, ALNUM, 6),
  githubPat: () => "github" + "_pat_" + rnd(60, ALNUM + "_", 6),
  google: () => "AI" + "za" + rnd(35, ALNUM + "_-", 8),
  serviceAccount: () => '{ "type": ' + '"service' + '_account" }',
  npm: () => "//registry.example.org/:_auth" + "Token=" + rnd(30, ALNUM, 9),
  jwt: () => ["ey" + "J" + rnd(20, ALNUM, 10), "ey" + "J" + rnd(20, ALNUM, 11), rnd(24, ALNUM, 12)].join("."),
  bearer: () => "Author" + "ization: Bea" + "rer " + rnd(40, ALNUM + "._-", 13),
  harbor: () => "hb" + "r_" + rnd(12, "0123456789abcdef", 14) + "_" + rnd(43, ALNUM + "_-", 14),
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-guard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const put = (rel: string, content: string | Buffer) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};

describe("the fake credentials are realistic (a weak fixture proves nothing)", () => {
  test("the generator produces high-entropy, varied strings", () => {
    expect(shannonEntropy(rnd(90, B64, 40))).toBeGreaterThan(5);
    expect(shannonEntropy(fake.anthropic())).toBeGreaterThan(4);
    expect(new Set(fake.github()).size).toBeGreaterThan(15);
  });
});

describe("content rules", () => {
  const cases: Array<[string, string, () => string]> = [
    ["private-key-block", "key", fake.privateKey],
    ["anthropic-key", "key", fake.anthropic],
    ["openai-style-key", "key", fake.openai],
    ["aws-access-key-id", "id", fake.awsId],
    ["aws-secret-key", "line", fake.awsSecretLine],
    ["slack-token", "tok", fake.slack],
    ["github-token", "tok", fake.github],
    ["github-token", "pat", fake.githubPat],
    ["google-api-key", "key", fake.google],
    ["gcp-service-account", "json", fake.serviceAccount],
    ["npm-auth-token", "rc", fake.npm],
    ["jwt", "tok", fake.jwt],
    ["bearer-token", "hdr", fake.bearer],
    ["harbor-token", "tok", fake.harbor],
  ];
  test.each(cases)("%s is caught (%s)", (rule, _label, make) => {
    const secret = make();
    const hits = scanText(`# notes\n\nsome prose\nhere: ${secret} and more\n`);
    expect(hits.map((h) => h.rule)).toContain(rule);
    expect(hits.find((h) => h.rule === rule)?.line).toBe(4);
    expect(JSON.stringify(hits)).not.toContain(secret); // the output never carries the secret
  });

  test("prose and ordinary code are not flagged", () => {
    const clean = [
      "# Onboarding",
      "Remember to rotate keys quarterly and never paste a password into chat.",
      "The task-based approach and risk-adjusted returns are covered in section 4.",
      "const sum = (a, b) => a + b;",
      "See https://example.com/docs/getting-started for details.",
      "commit 9fceb02d0ae598e95dc970b74767f19372d61af9 fixed it",
      "sha256: " + rnd(64, "0123456789abcdef", 21),
      "path: /usr/local/lib/python3.11/site-packages/numpy/core/_multiarray_umath",
    ].join("\n");
    expect(scanText(clean)).toEqual([]);
  });

  test("credential-assignment: a real-looking value is flagged, references and stand-ins are not", () => {
    const value = rnd(28, ALNUM, 30);
    expect(scanText(`api_key = "${value}"`).map((h) => h.rule)).toContain("credential-assignment");
    expect(scanText(`password: ${value}`).map((h) => h.rule)).toContain("credential-assignment");
    for (const ok of [
      "api_key = ${API_KEY}",
      "api_key = $API_KEY_FROM_ENV_VAR",
      'password: "<your-password-here>"',
      "secret: changeme-changeme-changeme",
      "api_key = xxxxxxxxxxxxxxxxxxxxxxxx",
      "token = aaaaaaaaaaaaaaaaaaaaaaaa",
      "secret: {{ vault.lookup }}",
      "api_key = your_api_key_goes_here_ok",
    ]) {
      expect(scanText(ok), ok).toEqual([]);
    }
  });

  test("high-entropy blobs: random base64 is flagged; hashes, repeats and short strings are not", () => {
    expect(scanText(`blob ${rnd(90, B64, 40)} end`).map((h) => h.rule)).toContain("high-entropy-blob");
    expect(scanText(rnd(64, "0123456789abcdef", 41))).toEqual([]); // bare hex: a checksum
    expect(scanText("a".repeat(120))).toEqual([]); // no entropy
    expect(scanText(rnd(40, B64, 42))).toEqual([]); // under 64 chars
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy(rnd(200, B64, 43))).toBeGreaterThan(5);
  });

  test("false positives a real user hits every day are NOT flagged…", () => {
    const quiet = [
      "const secret = made.token.slice(prefix.length);",
      "password = getPasswordFromVault",
      "secret = process.env.DEPLOY_SECRET_VALUE",
      "api_key = settings.integrations.mailer.key",
      "db_password = load_db_password_field",
      "expect(looksLikeSecret('apiKey', 'sk-or-v1-EXAMPLE0000NOTAREALKEY0000EXAMPLE')).toBe('api-key')",
      "Authorization: Bearer EXAMPLE-NOT-A-REAL-CREDENTIAL-0000",
      "aws_access_key_id = " + "AKIA" + "IOSFODNN7" + "EXAMPLE",
      "sk" + "-ant-api03-PLACEHOLDER-PLACEHOLDER-PLACEHOLDER",
      '      "integrity": "sha512-' + rnd(86, B64, 61) + '==",',
    ];
    for (const line of quiet) expect(scanText(line), line).toEqual([]);
  });

  test("…while genuinely random values are still caught, even on a line that says 'example'", () => {
    const noisy = `# example config: password = ${rnd(30, ALNUM, 62)}`;
    expect(scanText(noisy).map((h) => h.rule)).toContain("credential-assignment");
    expect(scanText(`example: ${fake.github()}`).map((h) => h.rule)).toContain("github-token");
    // an integrity hash is exempt, but the same blob NOT preceded by sha###- is not
    const blob = rnd(86, B64, 63);
    expect(scanText(`sha512-${blob}`)).toEqual([]);
    expect(scanText(`token ${blob}`).map((h) => h.rule)).toContain("high-entropy-blob");
  });

  test("a rejected first match does not hide a real one later on the same line", () => {
    const line = `api_key = xxxxxxxxxxxxxxxxxxxx and later password: ${rnd(30, ALNUM, 50)}`;
    expect(scanText(line).map((h) => h.rule)).toContain("credential-assignment");
  });

  test("reports the FIRST line for each rule, and each rule once", () => {
    const a = fake.github();
    const b = fake.github();
    const hits = scanText(`x\ny ${a}\nz\nw ${b}\n`).filter((h) => h.rule === "github-token");
    expect(hits).toEqual([{ rule: "github-token", line: 2 }]);
  });
});

describe("filename rules", () => {
  test.each([
    ["server.pem", "private-key-file"],
    ["deploy/id.key", "private-key-file"],
    ["a/b/cert.p12", "private-key-file"],
    ["store.pfx", "private-key-file"],
    ["team.vault", "vault-file"],
    [".env", "dotenv-file"],
    [".env.production", "dotenv-file"],
    ["home/.env.local", "dotenv-file"],
    ["id_rsa", "ssh-key-file"],
    ["id_ed25519", "ssh-key-file"],
    ["config.toml", "harbor-config"],
    ["aws-credentials.txt", "credentials-name"],
    ["client_secret.json", "secret-name"],
    ["api-token.md", "token-name"],
    ["private-notes.md", "private-name"],
    ["vault/notes.md", "secret-directory"],
    ["a/secrets/x.md", "secret-directory"],
    ["audit.db", "harbor-state"],
    ["x/y.db-wal", "harbor-state"],
    [".agent-env/config.toml", "harbor-state"],
  ])("%s → %s", (path, rule) => {
    expect(scanFilename(path)).toContain(rule);
  });

  test.each(["notes.md", "skills/nda-review/SKILL.md", "context/plan.txt", "id_rsa.pub", "README.md", "inbox/report.pdf", "keyboard.md"])(
    "%s is fine",
    (path) => {
      expect(scanFilename(path)).toEqual([]);
    },
  );

  test("a directory NAMED secrets is flagged for what is in it, not for a same-named file", () => {
    expect(scanFilename("secrets")).toContain("secret-name"); // as a file name it matches the name rule
    expect(scanFilename("docs/secrets/readme.md")).toContain("secret-directory");
    expect(scanFilename("docs/secretary.md")).toContain("secret-name"); // blunt by design (documented)
  });
});

describe("scanTree", () => {
  test("a clean tree passes, and says how much it looked at", () => {
    put("context/plan.md", "# Plan\n\nShip it.\n");
    put("skills/global/a/SKILL.md", "---\nname: a\n---\nBody\n");
    put("inbox/note.txt", "hello");
    const r = scanTree(dir);
    expect(r).toMatchObject({ scanned: 3, findings: [], skipped: [], excluded: 0 });
    expect(guardPassed(r)).toBe(true);
  });

  test("finds content and filename problems, with paths and line numbers, sorted", () => {
    put("context/keys.md", `line one\nline two\ntoken here: ${fake.github()}\n`);
    put(".env", "FOO=bar\n");
    put("deep/er/notes.md", "fine\n");
    const r = scanTree(dir);
    const expected: GuardFinding[] = [
      { path: ".env", kind: "filename", rule: "dotenv-file" },
      { path: "context/keys.md", kind: "content", rule: "github-token", line: 3 },
    ];
    expect(r.findings).toEqual(expected);
    expect(guardPassed(r)).toBe(false);
  });

  test("the report never contains the secret — not in findings, not when serialised", () => {
    const secrets = [fake.github(), fake.awsId(), fake.privateKey(), fake.anthropic()];
    put("a/notes.md", secrets.join("\n") + "\n");
    const json = JSON.stringify(scanTree(dir));
    for (const s of secrets) expect(json).not.toContain(s);
    expect(json).toContain("github-token");
  });

  test("does NOT follow symlinks: a link is a finding, and what it points at is never read or listed", () => {
    const outside = mkdtempSync(join(tmpdir(), "harbor-guard-outside-"));
    try {
      writeFileSync(join(outside, "loot.md"), `${fake.github()}\n`);
      mkdirSync(join(dir, "shared"));
      symlinkSync(outside, join(dir, "shared", "linkdir"));
      symlinkSync(join(outside, "loot.md"), join(dir, "shared", "linkfile.md"));
      symlinkSync(dir, join(dir, "shared", "loop")); // a cycle back to the root
      const r = scanTree(dir);
      expect(r.findings.map((f) => `${f.path}:${f.kind}`).sort()).toEqual([
        "shared/linkdir:symlink",
        "shared/linkfile.md:symlink",
        "shared/loop:symlink",
      ]);
      expect(JSON.stringify(r)).not.toContain("github-token"); // the outside file was never opened
      expect(r.scanned).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("node_modules is excluded by default and LISTED; a .git directory is itself a finding, never a silent pass", () => {
    put(".git/config", `[remote "origin"]\n\turl = https://x-access-token:${fake.github()}@github.com/o/r\n`);
    put("node_modules/pkg/index.js", `${fake.github()}\n`);
    put("ok.md", "fine");
    const r = scanTree(dir);
    expect(r.findings).toEqual([{ path: ".git", kind: "filename", rule: "git-directory" }]);
    expect(r.excluded).toBe(2); // .git and node_modules were stepped over...
    expect(r.excludedPaths.sort()).toEqual([".git", "node_modules"]); // ...and the report says so
    expect(guardPassed(r)).toBe(false); // the repository is the problem
    // scanning inside it too (nothing excluded) finds the token itself
    const all = scanTree(dir, { exclude: [] });
    expect(all.findings.some((f) => f.path === ".git/config")).toBe(true);
    expect(all.findings.some((f) => f.path.startsWith("node_modules/"))).toBe(true);
    expect(all.excluded).toBe(0);
  });

  test("a .git FILE (a worktree or submodule pointer) is flagged too, and --allow can exempt it", () => {
    put("sub/.git", "gitdir: ../.git/modules/sub\n");
    expect(scanTree(dir).findings).toEqual([{ path: "sub/.git", kind: "filename", rule: "git-directory" }]);
    expect(scanTree(dir, { allow: ["sub/.git"] }).findings).toEqual([]);
  });

  test("--strict also fails when anything was excluded: a token in node_modules/ is still in the folder", () => {
    put("node_modules/pkg/index.js", `${fake.github()}\n`);
    put("ok.md", "fine");
    const r = scanTree(dir);
    expect(r.findings).toEqual([]);
    expect(r.excluded).toBe(1);
    expect(guardPassed(r)).toBe(true); // default mode: reported, not failed
    expect(guardPassed(r, true)).toBe(false); // strict: unexamined means not passed
    expect(guardPassed(scanTree(dir, { exclude: [] }), true)).toBe(false); // ...because scanning it finds the token
  });

  test("things it cannot inspect are SKIPPED and reported — never silently passed", () => {
    put("big.txt", "x".repeat(2000));
    put("blob.bin", Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x00, 0x03]));
    const r = scanTree(dir, { maxBytes: 1000 });
    expect(r.skipped.map((s) => `${s.path}:${s.reason}`)).toEqual(["big.txt:too-large", "blob.bin:binary"]);
    expect(r.findings).toEqual([]);
    expect(guardPassed(r)).toBe(true);
    expect(guardPassed(r, true)).toBe(false); // strict: unscannable is not a pass
  });

  test("a secret hidden in a file just over the size limit is a SKIP, which strict mode refuses", () => {
    put("huge.md", `${"a ".repeat(600)}${fake.github()}`);
    const r = scanTree(dir, { maxBytes: 1000 });
    expect(r.skipped).toEqual([{ path: "huge.md", reason: "too-large" }]);
    expect(guardPassed(r, true)).toBe(false);
  });

  test("allow globs exempt known-good paths", () => {
    put("notes/token-budget.md", "how many tokens we spend\n");
    put("notes/api-token-usage.md", "same\n");
    put("secrets/real.md", "hidden\n");
    expect(scanTree(dir).findings.length).toBe(3);
    const r = scanTree(dir, { allow: ["notes/*token*.md"] });
    expect(r.findings.map((f) => f.path)).toEqual(["secrets/real.md"]);
    // **/ crosses directories; * does not
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("c.md")).toBe(true);
    expect(globToRegExp("*.md").test("a/c.md")).toBe(false);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a?c").test("a/c")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false); // regex metacharacters are literal
  });

  test("an empty tree and an empty file are fine", () => {
    put("empty.md", "");
    expect(scanTree(dir)).toMatchObject({ scanned: 1, findings: [] });
  });

  test("a missing or non-directory root is an error, not a clean pass", () => {
    expect(() => scanTree(join(dir, "nope"))).toThrow();
    put("file.txt", "x");
    expect(() => scanTree(join(dir, "file.txt"))).toThrow(/not a directory/);
  });
});

describe("files mode (scan only what changed)", () => {
  test("scans exactly the listed files", () => {
    put("a.md", `${fake.github()}\n`);
    put("b.md", `${fake.github()}\n`);
    const r = scanTree(dir, { files: ["a.md"] });
    expect(r.findings.map((f) => f.path)).toEqual(["a.md"]);
    expect(r.scanned).toBe(1);
  });

  test("a list is untrusted: traversal, absolute paths and links out of the root are refused, not read", () => {
    const outside = mkdtempSync(join(tmpdir(), "harbor-guard-outside-"));
    try {
      writeFileSync(join(outside, "loot.md"), `${fake.github()}\n`);
      mkdirSync(join(dir, "shared"));
      symlinkSync(outside, join(dir, "shared", "linkdir"));
      symlinkSync(join(outside, "loot.md"), join(dir, "shared", "linkfile.md"));
      const r = scanTree(dir, {
        files: [
          "../" + outside.split("/").pop() + "/loot.md",
          join(outside, "loot.md"),
          "shared/linkdir/loot.md", // an intermediate directory leads out
          "shared/linkfile.md", // the file itself is a link
          "missing.md",
        ],
      });
      expect(r.skipped.map((s) => `${s.reason}`).sort()).toEqual(["not-found", "outside-root", "outside-root", "outside-root"]);
      expect(r.findings).toEqual([{ path: "shared/linkfile.md", kind: "symlink", rule: "symlink" }]);
      expect(JSON.stringify(r)).not.toContain("github-token");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("blank lines and ./ prefixes in a list are tolerated", () => {
    put("a.md", "fine");
    expect(scanTree(dir, { files: ["", "  ", "./a.md"] })).toMatchObject({ scanned: 1, findings: [], skipped: [] });
  });
});
