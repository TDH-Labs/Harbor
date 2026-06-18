import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe("--help parses for every subcommand", () => {
  const commands = [
    "sync", "watch", "start", "stop", "dashboard", "bench",
    "scheduler", "compaction", "isolation", "session", "check", "init",
  ];
  test("root --help exits 0 and lists subcommands", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("scheduler");
  });
  for (const cmd of commands) {
    test(`${cmd} --help exits 0`, () => {
      const r = run(cmd, "--help");
      expect(r.code).toBe(0);
      expect((r.out + r.err).toLowerCase()).toContain(cmd);
    });
  }
});

describe("init + sync (--generate-only)", () => {
  test("init seeds agent_map.md and a stamped AGENTS.md", () => {
    const r = run("init", "--root", dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "agent_map.md"))).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- agent-env:sync -->");
  });

  test("sync --generate-only produces AGENTS.md with the sync stamp", () => {
    const r = run("sync", "--generate-only", "--root", dir);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- agent-env:sync -->");
  });
});

describe("session round-trip", () => {
  test("start then active reports the live session", () => {
    const start = run("session", "start", "ops", "5000", "--root", dir);
    expect(start.code).toBe(0);
    expect(start.out).toContain("started in ops");

    const active = run("session", "active", "--root", dir);
    expect(active.code).toBe(0);
    expect(active.out).toContain("ops");
  });
});

describe("scheduler stats", () => {
  test("prints task counts by state", () => {
    const r = run("scheduler", "stats", "--root", dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tasks by state:");
    expect(r.out).toContain("queued:");
  });

  test("submit then list shows the task", () => {
    const submit = run("scheduler", "submit", "cleanup", "--room", "devops", "--priority", "5", "--root", dir);
    expect(submit.code).toBe(0);
    expect(submit.out).toContain("queued task");

    const list = run("scheduler", "list", "--root", dir);
    expect(list.out).toContain("devops/cleanup");
  });
});

describe("isolation rooms", () => {
  test("reports no rooms under the default (de-personalized) config", () => {
    const r = run("isolation", "rooms", "--root", dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(no rooms configured)");
  });
});
