import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import {
  BudgetError,
  CompactionEngine,
  estimateTokens,
  loadSkillTier,
} from "./compaction.ts";
import { Environment } from "./env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-comp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tok = (n: number) => "x".repeat(n * 4); // n tokens worth of content

function engine(opts: { sessionId?: string; tokenLimit?: number; db?: string } = {}) {
  return new CompactionEngine({
    db: opts.db ?? ":memory:",
    sessionId: opts.sessionId ?? "sess-1",
    tokenLimit: opts.tokenLimit ?? 1000,
    clock: () => 1000,
  });
}

describe("estimateTokens", () => {
  test("is chars/4 with a floor of 1", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("x".repeat(40))).toBe(10);
  });
});

describe("load / get", () => {
  test("loading accrues tokens and get returns the entry", () => {
    const e = engine();
    e.load("a", tok(10));
    expect(e.tokensUsed).toBe(10);
    expect(e.get("a")?.content).toBe(tok(10));
    expect(e.remainingBudget()).toBe(990);
    e.close();
  });

  test("get returns null for an unknown key", () => {
    const e = engine();
    expect(e.get("missing")).toBeNull();
    e.close();
  });
});

describe("budget enforcement", () => {
  test("throws BudgetError when content cannot fit and nothing is evictable", () => {
    const e = engine({ tokenLimit: 10 });
    expect(() => e.load("big", tok(20))).toThrow(BudgetError);
    e.close();
  });

  test("re-loading the same key does not double-count (fix #2)", () => {
    const e = engine();
    e.load("k", tok(10));
    e.load("k", tok(10));
    expect(e.tokensUsed).toBe(10); // not 20
    e.load("k", tok(25)); // grow the same key
    expect(e.tokensUsed).toBe(25);
    e.close();
  });
});

describe("LRU eviction", () => {
  test("evicts the least-recently-used entry to make room, archiving content", () => {
    const e = engine({ tokenLimit: 30 });
    e.load("a", tok(10));
    e.load("b", tok(10));
    e.load("c", tok(10)); // full: used 30
    e.get("a"); // touch A → now MRU; B is the LRU
    e.load("d", tok(10)); // forces one eviction
    expect(e.get("b")).toBeNull(); // B evicted
    expect(e.get("a")?.content).toBe(tok(10)); // A survived
    expect(e.get("d")?.content).toBe(tok(10));
    expect(e.retrieve("b")).toBe(tok(10)); // archived content retrievable
    e.close();
  });

  test("evictLRU() with no target drains from 85% threshold toward 60%", () => {
    const e = engine({ tokenLimit: 100 });
    for (let i = 0; i < 9; i++) e.load(`k${i}`, tok(10)); // used 90 (> 85)
    const freed = e.evictLRU();
    expect(freed).toBe(30);
    expect(e.tokensUsed).toBe(60);
    e.close();
  });

  test("evictLRU(target) frees at least the requested tokens", () => {
    const e = engine({ tokenLimit: 1000 });
    e.load("a", tok(10));
    e.load("b", tok(10));
    expect(e.evictLRU(5)).toBeGreaterThanOrEqual(5);
    e.close();
  });
});

describe("archive retrieval", () => {
  test("evict then retrieve returns archived content; reload restores it", () => {
    const e = engine();
    e.load("doc", tok(10));
    expect(e.evict("doc")).toBe(true);
    expect(e.tokensUsed).toBe(0);
    expect(e.retrieve("doc")).toBe(tok(10));
    const reloaded = e.reloadFromArchive("doc");
    expect(reloaded?.content).toBe(tok(10));
    expect(e.tokensUsed).toBe(10);
    e.close();
  });

  test("retrieve returns null for an unknown key", () => {
    const e = engine();
    expect(e.retrieve("nope")).toBeNull();
    e.close();
  });
});

describe("spend", () => {
  test("debits the budget without storing content", () => {
    const e = engine();
    e.spend("api-call", 500);
    expect(e.tokensUsed).toBe(500);
    expect(e.remainingBudget()).toBe(500);
    e.close();
  });
});

describe("session reload", () => {
  test("restores tokensUsed without double-counting (fix #1)", () => {
    const dbPath = join(dir, "compaction.db");
    const a = new CompactionEngine({ db: dbPath, sessionId: "s", tokenLimit: 1000, clock: () => 1000 });
    a.load("x", tok(10));
    a.load("y", tok(10));
    expect(a.tokensUsed).toBe(20);
    a.close();

    const b = new CompactionEngine({ db: dbPath, sessionId: "s", clock: () => 2000 });
    expect(b.tokenLimit).toBe(1000); // restored from the budget row
    expect(b.tokensUsed).toBe(20); // not 40
    expect(b.stats().loadedItems).toBe(2);
    b.close();
  });
});

describe("stats", () => {
  test("reports loaded items, largest item, and archive count", () => {
    const e = engine();
    e.load("a", tok(5));
    e.load("b", tok(20));
    e.evict("a");
    const s = e.stats();
    expect(s.loadedItems).toBe(1);
    expect(s.largestItem).toBe(20);
    expect(s.archivedCount).toBe(1);
    expect(s.tokensUsed).toBe(20);
    e.close();
  });
});

describe("loadSkillTier", () => {
  function envWithSkill(): Environment {
    const skillsDir = join(dir, "skills");
    mkdirSync(join(skillsDir, "myskill"), { recursive: true });
    writeFileSync(
      join(skillsDir, "myskill", "SKILL.md"),
      "---\nname: myskill\ndescription: Does a thing well\n---\n# My Skill\nBody text here.\n",
    );
    const cfg = new Config(deepMerge(DEFAULTS, { paths: { skills_dir: skillsDir } }));
    return new Environment(dir, cfg);
  }

  test("index tier carries the skill description", () => {
    const env = envWithSkill();
    const e = engine();
    const entry = loadSkillTier(e, env, "myskill", "index");
    expect(entry?.content).toContain("Does a thing well");
    expect(entry?.tier).toBe("index");
    e.close();
  });

  test("full tier carries the whole SKILL.md", () => {
    const env = envWithSkill();
    const e = engine();
    const entry = loadSkillTier(e, env, "myskill", "full");
    expect(entry?.content).toContain("Body text here.");
    e.close();
  });

  test("returns null for an unknown skill", () => {
    const env = envWithSkill();
    const e = engine();
    expect(loadSkillTier(e, env, "ghost", "full")).toBeNull();
    e.close();
  });
});
