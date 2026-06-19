import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BudgetExceededError, checkBudget, spendBudget } from "./budget.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-budget-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

describe("checkBudget / spendBudget", () => {
  test("check → spend → check sequence with budget exhaustion", () => {
    const e = env();
    const sid = "sess-1";

    // First call seeds the session's token limit at 100.
    let r = checkBudget(sid, "a", 60, { env: e, tokenLimit: 100 });
    expect(r.ok).toBe(true);
    expect(r.limit).toBe(100);
    expect(r.used).toBe(0);
    expect(r.remaining).toBe(100);

    const spent = spendBudget(sid, "a", 60, { env: e });
    expect(spent.ok).toBe(true);
    expect(spent.used).toBe(60);
    expect(spent.remaining).toBe(40);

    // 60 used of 100 → a 60-token load no longer fits.
    r = checkBudget(sid, "b", 60, { env: e });
    expect(r.ok).toBe(false);
    expect(r.remaining).toBe(40);
    expect(r.reason).toContain("budget exceeded");

    // spendBudget enforces the same gate even if checkBudget is skipped.
    expect(() => spendBudget(sid, "b", 60, { env: e })).toThrow(BudgetExceededError);
  });

  test("checkBudget is pure — it never mutates the budget", () => {
    const e = env();
    const sid = "sess-pure";
    spendBudget(sid, "x", 10, { env: e, tokenLimit: 100 });

    const a = checkBudget(sid, "y", 5, { env: e });
    const b = checkBudget(sid, "y", 5, { env: e });
    expect(a.used).toBe(10);
    expect(b.used).toBe(10); // two checks did not add anything
  });

  test("BudgetExceededError carries the request context", () => {
    const e = env();
    const sid = "sess-err";
    spendBudget(sid, "fill", 95, { env: e, tokenLimit: 100 });
    try {
      spendBudget(sid, "over", 50, { env: e });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const be = err as BudgetExceededError;
      expect(be.sessionId).toBe(sid);
      expect(be.key).toBe("over");
      expect(be.requested).toBe(50);
      expect(be.remaining).toBe(5);
      expect(be.limit).toBe(100);
    }
  });

  test("re-spending the same key debits the old amount (no double counting)", () => {
    const e = env();
    const sid = "sess-rekey";
    spendBudget(sid, "k", 30, { env: e, tokenLimit: 100 });
    spendBudget(sid, "k", 50, { env: e }); // replaces 30 with 50, not 30+50
    expect(checkBudget(sid, "probe", 0, { env: e }).used).toBe(50);
  });

  test("spendBudget never silently evicts prior context to fit a new spend", () => {
    const e = env();
    const sid = "sess-noevict";
    spendBudget(sid, "first", 80, { env: e, tokenLimit: 100 });
    // A second spend that would require eviction is denied, not absorbed by evicting "first".
    expect(() => spendBudget(sid, "second", 40, { env: e })).toThrow(BudgetExceededError);
    // "first" is intact: still 80 used.
    expect(checkBudget(sid, "probe", 0, { env: e }).used).toBe(80);
  });
});
