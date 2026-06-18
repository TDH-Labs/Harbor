import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { listSessions } from "./session.ts";
import { SpawnTimeoutError, awaitExit, listActiveSpawns, spawn } from "./spawn.ts";

// NOTE: every test here spawns a throwaway local binary (echo / sh / true /
// sleep) under a temp-dir environment. Nothing live, no network, no ports, no
// touching the real machine (BUILD_BRIEF §9.5 / phase rule).

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-spawn-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

async function readStream(s: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  if (!s || typeof s === "number") return "";
  return new Response(s).text();
}

describe("spawn", () => {
  test("owns the child: PID tracked, metadata attached, exit code captured", async () => {
    const e = env();
    const child = spawn("echo", ["hello"], { harborEnv: e, room: "ops", budget: 5000 });
    expect(child.pid).toBeGreaterThan(0);
    expect(child.room).toBe("ops");
    expect(child.sessionId).toBeTruthy();
    expect(child.budget).toBe(5000);

    const code = await child.exited;
    expect(code).toBe(0);
    expect(child.exitCode).toBe(0);
    expect(child.timedOut).toBe(false);
    expect((await readStream(child.stdout)).trim()).toBe("hello");

    // No tokens spent by echo → full budget remaining.
    expect(child.tokensUsed).toBe(0);
    expect(child.budgetRemaining).toBe(5000);
  });

  test("injects AGENT_ENV_ROOM / AGENT_ENV_SESSION into the child environment", async () => {
    const e = env();
    const child = spawn("sh", ["-c", 'printf "%s|%s" "$AGENT_ENV_ROOM" "$AGENT_ENV_SESSION"'], {
      harborEnv: e,
      room: "legal",
    });
    await child.exited;
    const [room, session] = (await readStream(child.stdout)).split("|");
    expect(room).toBe("legal");
    expect(session).toBe(child.sessionId);
  });

  test("passes allowedPaths through as AGENT_ENV_ALLOWED_PATHS (logical sandbox)", async () => {
    const e = env();
    const child = spawn("sh", ["-c", 'printf "%s" "$AGENT_ENV_ALLOWED_PATHS"'], {
      harborEnv: e,
      room: "ops",
      allowedPaths: ["/tmp/a", "/tmp/b"],
    });
    await child.exited;
    expect(await readStream(child.stdout)).toBe("/tmp/a:/tmp/b");
    expect(child.allowedPaths).toEqual(["/tmp/a", "/tmp/b"]);
  });

  test("enforces a wall-clock timeout: child is killed, exitCode normalizes to -1", async () => {
    const e = env();
    const child = spawn("sleep", ["5"], { harborEnv: e, room: "ops", timeout: 150 });
    const code = await child.exited;
    expect(child.timedOut).toBe(true);
    expect(code).toBe(-1);
    expect(child.exitCode).toBe(-1);
  });

  test("awaitExit throws the typed SpawnTimeoutError on a timed-out child", async () => {
    const e = env();
    const child = spawn("sleep", ["5"], { harborEnv: e, room: "ops", timeout: 150 });
    await expect(awaitExit(child)).rejects.toThrow(SpawnTimeoutError);
  });

  test("listActiveSpawns tracks a live child and drops it after exit", async () => {
    const e = env();
    const child = spawn("sleep", ["2"], { harborEnv: e, room: "ops" });
    expect(listActiveSpawns().some((s) => s.pid === child.pid)).toBe(true);
    child.kill();
    await child.exited;
    expect(listActiveSpawns().some((s) => s.pid === child.pid)).toBe(false);
  });

  test("creates and rolls up a session with the process", async () => {
    const e = env();
    const child = spawn("true", [], { harborEnv: e, room: "ops", budget: 1234 });
    await child.exited;
    const rolled = listSessions(e).find((s) => s.sessionId === child.sessionId);
    expect(rolled).toBeTruthy();
    expect(rolled?.tokenLimit).toBe(1234);
    expect(rolled?.status).toBe("completed");
  });
});
