import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { CooldownGate, PidFile, Watcher, watcherStatus } from "./watch.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-watch-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  // state_dir under the temp root so nothing touches a real home.
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await Bun.sleep(15);
  }
  return predicate();
}

describe("CooldownGate", () => {
  test("first event fires immediately; within-window events coalesce, never drop", () => {
    let now = 1000;
    const gate = new CooldownGate(10, () => now);

    expect(gate.onEvent()).toBe(true); // first → fire now
    expect(gate.onEvent()).toBe(false); // within window → coalesced
    expect(gate.isPending).toBe(true);

    now = 1005;
    expect(gate.due()).toBe(false); // 5s < 10s cooldown

    now = 1011;
    expect(gate.due()).toBe(true); // 11s ≥ 10s → deferred sync fires once
    expect(gate.due()).toBe(false); // and only once
    expect(gate.isPending).toBe(false);
  });

  test("an event past the cooldown window fires immediately again", () => {
    let now = 1000;
    const gate = new CooldownGate(10, () => now);
    expect(gate.onEvent()).toBe(true);
    now = 1020;
    expect(gate.onEvent()).toBe(true);
  });
});

describe("PidFile", () => {
  test("write/read/isRunning/remove", () => {
    const pf = new PidFile(join(dir, "watcher.pid"));
    expect(pf.read()).toBeNull();
    expect(pf.isRunning()).toBe(false);

    pf.write(process.pid);
    expect(pf.read()).toBe(process.pid);
    expect(pf.isRunning()).toBe(true); // this very process is alive

    pf.write(999999); // a pid that does not exist
    expect(pf.isRunning()).toBe(false);

    pf.remove();
    expect(pf.read()).toBeNull();
  });
});

describe("watcherStatus", () => {
  test("reports not-running when no pidfile exists", () => {
    expect(watcherStatus(env())).toEqual({ running: false, pid: null });
  });
});

describe("Watcher integration (temp dir only)", () => {
  test("a file change triggers the sync callback", async () => {
    const e = env();
    let synced = 0;
    const watcher = new Watcher(e, {
      paths: [dir],
      cooldownSeconds: 0, // every event fires immediately
      syncFn: () => {
        synced += 1;
      },
      pollIntervalMs: 20,
      chokidarOptions: { usePolling: true, interval: 20 },
    });
    watcher.start();
    try {
      // Give chokidar a moment to establish the watch, then mutate.
      await Bun.sleep(150);
      writeFileSync(join(dir, "trigger.txt"), "hello");
      const fired = await waitFor(() => synced > 0);
      expect(fired).toBe(true);
      expect(watcher.syncCount).toBeGreaterThan(0);
    } finally {
      await watcher.stop();
    }
  });
});
