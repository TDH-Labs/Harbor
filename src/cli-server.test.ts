/**
 * cli-server.test.ts — `harbor serve | tenant | token | service` and the
 * dashboard's bind policy, through the real command tree.
 *
 * Most cases run IN-PROCESS (citty `runCommand`, as cli.test.ts does). The two
 * end-to-end cases spawn the real binary, because stream separation (the token
 * on stdout, notes on stderr) and SIGTERM draining are properties of a process.
 * Every case passes an explicit `--data-dir`/`--home`: nothing here touches the
 * real user's home.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "citty";

import { main } from "./cli.ts";
import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";
import { createServerHandler } from "./http-server.ts";

const CLI = join(import.meta.dir, "cli.ts");

let dir: string;
let data: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-cli-server-"));
  data = join(dir, "data");
});
afterEach(() => {
  closeAllDbs();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = [];
  const sink = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
  };
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  const savedExit = process.exitCode;
  console.log = sink as typeof console.log;
  console.error = sink as typeof console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    logs.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
  let threw = false;
  try {
    await runCommand(main, { rawArgs: args });
  } catch (err) {
    threw = true;
    sink(err instanceof Error ? err.message : String(err));
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
  }
  const code = threw ? 1 : typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = savedExit ?? 0; // (assigning undefined does NOT reset it in Bun)
  return { code, out: logs.join("\n") };
}

const D = () => ["--data-dir", data];

/**
 * `--json` output goes through printJson, which writes straight to fd 1 (so a
 * large payload cannot be truncated on a pipe) and therefore cannot be captured
 * in-process. Those cases run the real binary.
 */
function harborJson<T>(...args: string[]): T {
  const p = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`harbor ${args.join(" ")} exited ${p.exitCode}: ${p.stderr.toString()}`);
  return JSON.parse(p.stdout.toString()) as T;
}

describe("harbor tenant", () => {
  test("create builds the tenant and prints how to use it", async () => {
    const r = await cli("tenant", "create", "acme", ...D());
    expect(r.code).toBe(0);
    expect(r.out).toContain("tenant 'acme' created");
    expect(r.out).toContain(join(data, "tenants", "acme"));
    expect(r.out).toContain("--config");
    expect(existsSync(join(data, "tenants", "acme", ".agent-env", "config.toml"))).toBe(true);
    expect(readFileSync(join(data, "tenants", "acme", ".agent-env", "config.toml"), "utf8")).toContain("[paths]");
  });

  test("a duplicate id and a hostile id fail with a message and a non-zero exit", async () => {
    await cli("tenant", "create", "acme", ...D());
    const dup = await cli("tenant", "create", "acme", ...D());
    expect(dup.code).toBe(1);
    expect(dup.out).toContain("already exists");
    for (const bad of ["../escape", "A", "a_b", "x".repeat(41)]) {
      const r = await cli("tenant", "create", bad, ...D());
      expect(r.code, bad).toBe(1);
      expect(r.out, bad).toContain("invalid tenant id");
    }
    expect(existsSync(join(dir, "escape"))).toBe(false);
  });

  test("list (text and --json), suspend, resume", async () => {
    await cli("tenant", "create", "acme", ...D());
    await cli("tenant", "create", "globex", ...D());
    await cli("token", "create", "--tenant", "acme", "--room", "general", ...D());
    const json = harborJson<Array<{ id: string; status: string; tokens: number }>>("tenant", "list", "--json", ...D());
    expect(json.map((t) => [t.id, t.status, t.tokens])).toEqual([["acme", "active", 1], ["globex", "active", 0]]);

    expect((await cli("tenant", "suspend", "acme", ...D())).out).toContain("suspended");
    expect((await cli("tenant", "list", ...D())).out).toMatch(/acme\s+suspended/);
    expect((await cli("tenant", "resume", "acme", ...D())).out).toContain("resumed");
    const missing = await cli("tenant", "suspend", "nobody", ...D());
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("no such tenant");
  });

  test("an empty install lists nothing, gracefully", async () => {
    expect((await cli("tenant", "list", ...D())).out).toContain("(no tenants)");
  });
});

describe("harbor token", () => {
  beforeEach(async () => {
    await cli("tenant", "create", "acme", ...D());
  });

  test("create prints a token; --json adds the record but no hash", async () => {
    const plain = await cli("token", "create", "--tenant", "acme", "--room", "general", "--label", "ci", ...D());
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/hbr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/);
    expect(plain.out).toContain("only time the secret is shown");

    const j = harborJson<Record<string, unknown>>("token", "create", "--tenant", "acme", "--room", "general", "--json", ...D());
    expect(String(j.token)).toMatch(/^hbr_/);
    expect(j.tenantId).toBe("acme");
    expect(JSON.stringify(j)).not.toMatch(/secret_hash|secretHash/);
  });

  test("required flags and bad values are refused", async () => {
    expect((await cli("token", "create", "--room", "general", ...D())).code).toBe(1);
    expect((await cli("token", "create", "--tenant", "acme", ...D())).code).toBe(1);
    const unconfigured = await cli("token", "create", "--tenant", "acme", "--room", "legal", ...D());
    expect(unconfigured.code).toBe(1);
    expect(unconfigured.out).toContain("not configured");
    expect((await cli("token", "create", "--tenant", "acme", "--room", "legal", "--allow-unconfigured-room", ...D())).code).toBe(0);
    expect((await cli("token", "create", "--tenant", "acme", "--room", "general", "--ttl-days", "0", ...D())).code).toBe(1);
    expect((await cli("token", "create", "--tenant", "acme", "--room", "general", "--capabilities", "bogus", ...D())).out).toContain("unknown capability");
    const admin = await cli("token", "create", "--tenant", "acme", "--room", "general", "--capabilities", "read_skill,admin", ...D());
    expect(admin.code).toBe(1);
    expect(admin.out).toContain("allowAdmin");
    expect((await cli("token", "create", "--tenant", "acme", "--room", "general", "--capabilities", "read_skill,admin", "--allow-admin", ...D())).code).toBe(0);
  });

  test("list shows handles and state, never secrets; revoke flips it", async () => {
    const made = harborJson<{ token: string; id: string }>("token", "create", "--tenant", "acme", "--room", "general", "--label", "ci-bot", "--json", ...D());
    const secret = made.token.slice(`hbr_${made.id}_`.length);
    const listed = await cli("token", "list", ...D());
    expect(listed.out).toContain(`hbr_${made.id}_…`);
    expect(listed.out).toContain("active");
    expect(listed.out).toContain("ci-bot");
    expect(listed.out).not.toContain(secret);

    expect((await cli("token", "revoke", made.id, ...D())).out).toContain("revoked");
    expect((await cli("token", "list", "--tenant", "acme", ...D())).out).toContain("revoked");
    const unknown = await cli("token", "revoke", "deadbeef0000", ...D());
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("no such token");
  });
});

describe("harbor tenant add-room", () => {
  test("creates the room; is idempotent; refuses hostile names", async () => {
    await cli("tenant", "create", "acme", ...D());
    const first = await cli("tenant", "add-room", "acme", "--room", "legal", "--description", "Contracts", ...D());
    expect(first.code).toBe(0);
    expect(first.out).toContain("room 'legal' created");
    expect(first.out).toContain("skill-install");
    expect(existsSync(join(data, "tenants", "acme", "rooms", "legal", "room_rules.md"))).toBe(true);
    expect((await cli("tenant", "add-room", "acme", "--room", "legal", ...D())).out).toContain("already exists");
    expect((await cli("tenant", "add-room", "acme", ...D())).code).toBe(1);
    for (const bad of ["../x", "a/b", ".h"]) {
      const r = await cli("tenant", "add-room", "acme", "--room", bad, ...D());
      expect(r.code, bad).toBe(1);
      expect(r.out, bad).toContain("invalid room name");
    }
  });
});

// The sequence docs/CLOUD.md tells an operator to run. If this test breaks, the
// quickstart is wrong — fix one or the other, never leave them disagreeing.
describe("the documented quickstart works end to end", () => {
  test("tenant → add-room → skill-install --config → token → MCP session over HTTP", async () => {
    const savedRouter = process.env.HARBOR_SYSTEM_ONE_URL;
    process.env.HARBOR_SYSTEM_ONE_URL = "http://127.0.0.1:59991"; // no router: keyword fallback
    const skillDir = join(dir, "incoming", "nda-review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: nda-review\ndescription: Review NDA agreements and flag risky clauses\n---\n\n# NDA review\n\nStep 1. Read the agreement.\n");

    expect((await cli("tenant", "create", "acme", ...D())).code).toBe(0);
    expect((await cli("tenant", "add-room", "acme", "--room", "legal", ...D())).code).toBe(0);
    const cfg = join(data, "tenants", "acme", ".agent-env", "config.toml");
    const installed = await cli("skill-install", skillDir, "--room", "legal", "--config", cfg);
    expect(installed.code, installed.out).toBe(0);

    // The skill landed INSIDE the tenant, not in the operator's home…
    const tenantRoot = join(data, "tenants", "acme");
    expect(existsSync(join(tenantRoot, ".agents", "skills", "nda-review", "SKILL.md"))).toBe(true);
    expect(Environment.load(cfg).skillsDir).toBe(join(tenantRoot, ".agents", "skills"));

    const made = await cli("token", "create", "--tenant", "acme", "--room", "legal", "--label", "quickstart", ...D());
    expect(made.code, made.out).toBe(0);
    const token = /hbr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/.exec(made.out)![0];

    const handler = createServerHandler({ dataDir: data, logger: () => {} });
    try {
      const rpc = async (body: unknown, session?: string) =>
        handler.fetch(
          new Request("http://harbor.test/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
              ...(session ? { "mcp-session-id": session } : {}),
            },
            body: JSON.stringify(body),
          }),
        );
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(init.status).toBe(200);
      const sid = init.headers.get("mcp-session-id")!;
      const text = async (name: string, args: Record<string, unknown>) => {
        const r = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sid)).json()) as {
          result: { content: Array<{ text: string }>; isError?: boolean };
        };
        return { text: r.result.content[0]!.text, isError: Boolean(r.result.isError) };
      };

      const listed = await text("list_skills", {});
      expect(listed.text).toContain("nda-review: Review NDA agreements");
      const routed = await text("route_skills", { prompt: "please review this NDA agreement" });
      expect(routed.text).toContain("nda-review");
      const read = await text("read_skill", { skill_name: "nda-review" });
      expect(read.isError).toBe(false);
      expect(read.text).toContain("Step 1. Read the agreement.");
    } finally {
      handler.close();
      Environment.unlockDefault();
      if (savedRouter === undefined) delete process.env.HARBOR_SYSTEM_ONE_URL;
      else process.env.HARBOR_SYSTEM_ONE_URL = savedRouter;
    }
  });
});

describe("harbor token --principal / quotas, and harbor principal", () => {
  beforeEach(async () => {
    await cli("tenant", "create", "acme", ...D());
  });

  test("a token can name its person and carry daily quotas; list shows both", async () => {
    const made = harborJson<{ token: string; id: string; principal: string; dailyTokenQuota: number; dailyReadQuota: number }>(
      "token", "create", "--tenant", "acme", "--room", "general", "--principal", "kim@example.com",
      "--daily-token-quota", "20000", "--daily-read-quota", "15", "--json", ...D(),
    );
    expect(made).toMatchObject({ principal: "kim@example.com", dailyTokenQuota: 20000, dailyReadQuota: 15 });
    const listed = (await cli("token", "list", ...D())).out;
    expect(listed).toContain("kim@example.com");
    expect(listed).toContain("quota/day: 20000 tok, 15 loads");
    // a token with neither shows a dash and no quota note
    await cli("token", "create", "--tenant", "acme", "--room", "general", ...D());
    const both = (await cli("token", "list", ...D())).out.split("\n").filter((l) => l.includes("hbr_"));
    expect(both.some((l) => !l.includes("quota/day") && l.includes(" - "))).toBe(true);
  });

  test("bad principals and quotas are refused before anything is created", async () => {
    for (const bad of ["kim lee", "../x", "-kim"]) {
      const r = await cli("token", "create", "--tenant", "acme", "--room", "general", "--principal", bad, ...D());
      expect(r.code, bad).toBe(1);
      expect(r.out, bad).toContain("invalid principal");
    }
    for (const q of ["0", "-5", "1.5", "abc"]) {
      const r = await cli("token", "create", "--tenant", "acme", "--room", "general", "--daily-token-quota", q, ...D());
      expect(r.code, q).toBe(1);
      expect(r.out, q).toContain("--daily-token-quota must be an integer");
    }
    expect((await cli("token", "list", ...D())).out).toContain("(no tokens)");
  });

  test("principal list / suspend / resume / revoke", async () => {
    await cli("token", "create", "--tenant", "acme", "--room", "general", "--principal", "kim", ...D());
    await cli("token", "create", "--tenant", "acme", "--room", "general", "--principal", "kim", ...D());
    await cli("token", "create", "--tenant", "acme", "--room", "general", "--principal", "lee", ...D());

    const rows = harborJson<Array<{ id: string; status: string; activeTokens: number }>>("principal", "list", "--tenant", "acme", "--json", ...D());
    expect(rows.map((r) => [r.id, r.status, r.activeTokens])).toEqual([["kim", "active", 2], ["lee", "active", 1]]);
    expect((await cli("principal", "list", ...D())).out).toMatch(/kim\s+active\s+2 token\(s\)/);

    expect((await cli("principal", "suspend", "kim", "--tenant", "acme", ...D())).out).toContain("suspended");
    expect((await cli("principal", "list", "--tenant", "acme", ...D())).out).toMatch(/kim\s+suspended/);
    expect((await cli("principal", "resume", "kim", "--tenant", "acme", ...D())).out).toContain("resumed");

    const revoked = await cli("principal", "revoke", "kim", "--tenant", "acme", ...D());
    expect(revoked.out).toContain("revoked 2 token(s)");
    expect((await cli("principal", "revoke", "kim", "--tenant", "acme", ...D())).out).toContain("revoked 0 token(s)");
    const active = harborJson<Array<{ id: string; activeTokens: number }>>("principal", "list", "--tenant", "acme", "--json", ...D());
    expect(active.find((r) => r.id === "kim")?.activeTokens).toBe(0);
    expect(active.find((r) => r.id === "lee")?.activeTokens).toBe(1); // untouched
  });

  test("--tenant is required, and unknown people/tenants are clean errors", async () => {
    for (const sub of ["suspend", "resume", "revoke"]) {
      const r = await cli("principal", sub, "kim", ...D());
      expect(r.code, sub).toBe(1);
      expect(r.out, sub).toContain("--tenant is required");
    }
    const ghost = await cli("principal", "suspend", "ghost", "--tenant", "acme", ...D());
    expect(ghost.code).toBe(1);
    expect(ghost.out).toContain("no such principal");
    expect((await cli("principal", "suspend", "kim", "--tenant", "nobody", ...D())).out).toContain("no such tenant");
    expect((await cli("principal", "list", ...D())).out).toContain("no people yet");
  });
});

describe("harbor guard", () => {
  // Assembled at runtime so no realistic credential is ever a literal in this file.
  const secret = () => "gh" + "p_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD2fH4jL6";
  const guardDir = () => join(dir, "shared");
  const put = (rel: string, body: string | Buffer) => {
    const p = join(guardDir(), rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  const run = (args: string[], stdin?: string) => {
    const p = Bun.spawnSync(["bun", CLI, "guard", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      ...(stdin !== undefined ? { stdin: Buffer.from(stdin) } : {}),
    });
    return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("a clean folder exits 0", () => {
    put("context/plan.md", "# Plan\n");
    const r = run([guardDir()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("guard: no findings.");
  });

  test("a secret exits 1, names the path, line and rule — and prints NONE of the secret", () => {
    put("context/notes.md", `one\ntwo\nkey: ${secret()}\n`);
    put(".env", "A=b\n");
    const r = run([guardDir()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("BLOCK  context/notes.md:3  content  github-token");
    expect(r.out).toContain("BLOCK  .env  filename  dotenv-file");
    expect(r.out).toContain("ROTATE");
    expect(r.out + r.err).not.toContain(secret());
  });

  test("--json carries the verdict and still no secret", () => {
    put("a.md", `${secret()}\n`);
    const p = Bun.spawnSync(["bun", CLI, "guard", guardDir(), "--json"], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(1);
    const report = JSON.parse(p.stdout.toString()) as { passed: boolean; findings: Array<{ rule: string }> };
    expect(report.passed).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain("github-token");
    expect(p.stdout.toString()).not.toContain(secret());
  });

  test("a missing folder or a bad option is exit 2 (an error), never a clean pass", () => {
    expect(run([join(dir, "does-not-exist")]).code).toBe(2);
    put("a.md", "x");
    expect(run([guardDir(), "--max-bytes", "abc"]).code).toBe(2);
    expect(run([guardDir(), "--files-from", join(dir, "no-such-list")]).code).toBe(2);
  });

  test("--strict turns 'could not inspect' into a failure; without it the skip is reported but passes", () => {
    put("big.md", "x".repeat(500));
    const lenient = run([guardDir(), "--max-bytes", "100"]);
    expect(lenient.code).toBe(0);
    expect(lenient.out).toContain("skip   big.md  (too-large)");
    expect(lenient.out).toContain("--strict");
    const strict = run([guardDir(), "--max-bytes", "100", "--strict"]);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("could not be inspected");
  });

  test("--allow exempts known-good paths; --exclude none scans .git too", () => {
    put("notes/token-budget.md", "how many tokens\n");
    expect(run([guardDir()]).code).toBe(1);
    expect(run([guardDir(), "--allow", "notes/*token*.md"]).code).toBe(0);
    put(".git/config", `${secret()}\n`);
    // a .git directory in a shared folder is itself a finding (its history, its remote URLs)...
    const withGit = run([guardDir(), "--allow", "notes/*token*.md"]);
    expect(withGit.code).toBe(1);
    expect(withGit.out).toContain("BLOCK  .git  filename  git-directory");
    // ...the operator can knowingly allow it (it is then stepped over, and LISTED)...
    const allowed = run([guardDir(), "--allow", "notes/*token*.md,.git"]);
    expect(allowed.code).toBe(0);
    expect(allowed.out).toMatch(/excl\s+\.git/);
    expect(run([guardDir(), "--allow", "notes/*token*.md,.git", "--strict"]).code).toBe(1); // strict: stepped over is not a pass
    // ...and scanning inside it (nothing excluded) finds the secret itself
    expect(run([guardDir(), "--allow", "notes/*token*.md", "--exclude", "none"]).code).toBe(1);
  });

  test("--files-from (a file, or '-' for stdin) scans only the listed paths and refuses ones that leave the folder", () => {
    put("a.md", `${secret()}\n`);
    put("b.md", `${secret()}\n`);
    const listFile = join(dir, "changed.txt");
    writeFileSync(listFile, "a.md\n");
    const fromFile = run([guardDir(), "--files-from", listFile]);
    expect(fromFile.code).toBe(1);
    expect(fromFile.out).toContain("a.md");
    expect(fromFile.out).not.toContain("b.md");

    const fromStdin = run([guardDir(), "--files-from", "-"], "b.md\n../shared/../../etc/passwd\n/etc/hostname\n");
    expect(fromStdin.out).toContain("BLOCK  b.md");
    expect(fromStdin.out).toContain("skip   ../shared/../../etc/passwd  (outside-root)");
    expect(fromStdin.out).toContain("skip   /etc/hostname  (outside-root)");
    expect(fromStdin.out).not.toContain("a.md");
  });
});

describe("harbor service print", () => {
  test("renders a systemd unit for the server", async () => {
    const r = await cli("service", "print", "--unit", "serve", "--target", "systemd", "--harbor-bin", "/usr/local/bin/harbor", "--port", "9000", "--data-dir", "/var/lib/harbor");
    expect(r.code).toBe(0);
    expect(r.out).toContain("ExecStart=/usr/local/bin/harbor serve");
    expect(r.out).toContain("Environment=HARBOR_PORT=9000");
    expect(r.out).toContain("systemctl --user enable --now harbor-serve.service");
  });

  test("renders a launchd plist for System One with the operator's command", async () => {
    const r = await cli("service", "print", "--unit", "system-one", "--target", "launchd", "--command", '/usr/local/bin/node "/opt/system one/server.js"', "--label", "com.example.router");
    expect(r.code).toBe(0);
    expect(r.out).toContain("<string>com.example.router</string>");
    expect(r.out).toContain("<string>/opt/system one/server.js</string>");
    expect(r.out).toContain("RunAtLoad");
  });

  test("refuses what would fail at boot: relative paths, missing command, bad unit/target/port", async () => {
    expect((await cli("service", "print", "--unit", "serve", "--target", "systemd", "--harbor-bin", "harbor")).out).toContain("absolute path");
    expect((await cli("service", "print", "--unit", "system-one", "--target", "systemd")).out).toContain("not part of this repository");
    expect((await cli("service", "print", "--target", "systemd")).code).toBe(1);
    expect((await cli("service", "print", "--unit", "bogus")).code).toBe(1);
    expect((await cli("service", "print", "--unit", "serve", "--target", "cron", "--harbor-bin", "/x")).code).toBe(1);
    expect((await cli("service", "print", "--unit", "serve", "--target", "systemd", "--harbor-bin", "/x", "--port", "99999")).code).toBe(1);
  });

  test("--write puts the file under --home, activates nothing, and will not clobber a different file", async () => {
    const home = join(dir, "home");
    const args = ["service", "print", "--unit", "watcher", "--target", "systemd", "--harbor-bin", "/usr/local/bin/harbor", "--home", home, "--write"];
    const first = await cli(...args);
    expect(first.code).toBe(0);
    const path = join(home, ".config", "systemd", "user", "harbor-watcher.service");
    expect(readFileSync(path, "utf8")).toContain("ExecStart=/usr/local/bin/harbor watch");
    expect((await cli(...args)).code).toBe(0); // identical content: idempotent
    rmSync(path);
    (await import("node:fs")).writeFileSync(path, "# hand-edited\n");
    const clobber = await cli(...args);
    expect(clobber.code).toBe(1);
    expect(clobber.out).toContain("not overwriting");
    expect(readFileSync(path, "utf8")).toBe("# hand-edited\n");
  });
});

describe("harbor serve — argument validation", () => {
  test("a bad port or rate limit is a clean error", async () => {
    expect((await cli("serve", "--port", "70000", ...D())).out).toContain("--port must be an integer");
    expect((await cli("serve", "--port", "abc", ...D())).code).toBe(1);
    expect((await cli("serve", "--rate-limit", "0", ...D())).code).toBe(1);
  });
});

describe("harbor dashboard — bind policy through the CLI", () => {
  test("a non-loopback host without HARBOR_DASHBOARD_TOKEN is refused (and the token is never an argv flag)", async () => {
    const saved = process.env.HARBOR_DASHBOARD_TOKEN;
    delete process.env.HARBOR_DASHBOARD_TOKEN;
    try {
      const r = await cli("dashboard", "--host", "0.0.0.0", "--port", "0", "--root", dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("without a token");
      expect(r.out).toContain("HARBOR_DASHBOARD_TOKEN");
    } finally {
      if (saved !== undefined) process.env.HARBOR_DASHBOARD_TOKEN = saved;
    }
    const help = readFileSync(CLI, "utf8");
    expect(help).not.toMatch(/dashboard[\s\S]{0,400}"token":\s*\{\s*type: "string"/); // no --token flag: argv leaks
  });
});

// ── real processes ───────────────────────────────────────────────────────────

describe("end to end (real processes)", () => {
  function harbor(...args: string[]) {
    const p = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test("token create: the secret alone on stdout, notes on stderr", () => {
    expect(harbor("tenant", "create", "acme", "--data-dir", data).code).toBe(0);
    const r = harbor("token", "create", "--tenant", "acme", "--room", "general", "--data-dir", data);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^hbr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/); // capturable with $(...)
    expect(r.err).toContain("only time the secret is shown");
  });

  test("serve: answers an authenticated MCP session over the network, then drains on SIGTERM", async () => {
    harbor("tenant", "create", "acme", "--data-dir", data);
    const token = harbor("token", "create", "--tenant", "acme", "--room", "general", "--data-dir", data).out.trim();

    const proc = Bun.spawn(["bun", CLI, "serve", "--data-dir", data, "--port", "0"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HARBOR_HOST: "127.0.0.1" },
    });
    try {
      // Learn the port from the human line on stderr.
      const reader = proc.stderr.getReader();
      let seen = "";
      const deadline = Date.now() + 10_000;
      let port = 0;
      while (!port && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
        port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(seen)?.[1] ?? 0);
      }
      expect(port, `serve did not report a port: ${seen}`).toBeGreaterThan(0);
      const base = `http://127.0.0.1:${port}`;

      expect((await fetch(base + "/readyz")).status).toBe(200);
      expect((await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);

      const init = await fetch(base + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(init.status).toBe(200);
      expect(init.headers.get("mcp-session-id")).toMatch(/^[0-9a-f]{32}$/);

      proc.kill("SIGTERM");
      const code = await Promise.race([proc.exited, new Promise<number>((r) => setTimeout(() => r(-999), 8000))]);
      expect(code).toBe(0); // a clean drain, not a kill
      // The access log is JSON lines on stdout and never contains the token.
      const out = await new Response(proc.stdout).text();
      const lines = out.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.some((l) => l.path === "/mcp" && l.status === 200 && l.tenant === "acme")).toBe(true);
      expect(out).not.toContain(token);
    } finally {
      proc.kill("SIGKILL");
    }
  });
});
