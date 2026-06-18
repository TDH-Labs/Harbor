import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompactionEngine } from "./compaction.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { lru, retrieve, stats } from "./evict.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-evict-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

describe("evict.lru / retrieve / stats", () => {
  test("lru frees tokens and the evicted entries are recoverable from the archive", () => {
    const e = env();
    const sid = "evict-1";
    // Load two real entries (40 tokens each) into the session, then close.
    const eng = new CompactionEngine({ env: e, sessionId: sid, tokenLimit: 100 });
    eng.load("skill:a:full", "A".repeat(160));
    eng.load("skill:b:full", "B".repeat(160));
    eng.close();
    expect(stats(sid, { env: e }).tokensUsed).toBe(80);

    const freed = lru(sid, { targetTokens: 80, env: e });
    expect(freed).toBe(80);
    expect(stats(sid, { env: e }).tokensUsed).toBe(0);

    // Both evicted entries are recoverable (non-null) from the archive.
    expect(retrieve(sid, "skill:a:full", { env: e })).not.toBeNull();
    expect(retrieve(sid, "skill:b:full", { env: e })).not.toBeNull();
  });

  test("retrieve returns the real archived content when evicted in-engine", () => {
    const e = env();
    const sid = "evict-2";
    const eng = new CompactionEngine({ env: e, sessionId: sid, tokenLimit: 100 });
    eng.load("skill:c:full", "real-content-xyz ".repeat(8));
    eng.evict("skill:c:full"); // archives the REAL content
    eng.close();
    expect(retrieve(sid, "skill:c:full", { env: e })).toContain("real-content-xyz");
  });

  test("retrieve returns null for an unknown key", () => {
    const e = env();
    expect(retrieve("nobody", "skill:missing", { env: e })).toBeNull();
  });

  test("lru with no target is a no-op below the eviction threshold", () => {
    const e = env();
    const sid = "evict-3";
    const eng = new CompactionEngine({ env: e, sessionId: sid, tokenLimit: 1000 });
    eng.load("skill:small:full", "x".repeat(40)); // 10 tokens, well under 85%
    eng.close();
    expect(lru(sid, { env: e })).toBe(0);
    expect(stats(sid, { env: e }).tokensUsed).toBe(10);
  });

  test("stats reports the live budget snapshot", () => {
    const e = env();
    const sid = "evict-4";
    const eng = new CompactionEngine({ env: e, sessionId: sid, tokenLimit: 500 });
    eng.load("k", "z".repeat(200)); // 50 tokens
    eng.close();
    const s = stats(sid, { env: e });
    expect(s.sessionId).toBe(sid);
    expect(s.tokenLimit).toBe(500);
    expect(s.tokensUsed).toBe(50);
    expect(s.remaining).toBe(450);
    expect(s.loadedItems).toBe(1);
  });
});
