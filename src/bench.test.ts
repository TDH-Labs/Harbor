import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WARMUP,
  type BenchRun,
  conditionFor,
  formatSummary,
  isMeasured,
  latestReport,
  median,
  parseSessionJsonl,
  runBench,
  summarize,
} from "./bench.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-bench-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

function run(index: number, over: Partial<BenchRun> = {}): BenchRun {
  return {
    index,
    condition: conditionFor(index),
    wallTimeSeconds: 1,
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    cost: 0.01,
    toolCalls: {},
    turns: 1,
    success: true,
    exitCode: 0,
    ...over,
  };
}

describe("design helpers", () => {
  test("conditionFor alternates control/harbor by index", () => {
    expect([0, 1, 2, 3].map(conditionFor)).toEqual(["control", "harbor", "control", "harbor"]);
  });

  test("warm-up discard excludes the first WARMUP runs", () => {
    expect(WARMUP).toBe(2);
    expect([0, 1, 2, 3, 4].map(isMeasured)).toEqual([false, false, true, true, true]);
  });
});

describe("median", () => {
  test("odd length returns the middle; even returns mean of the two middles; empty is 0", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  test("is the true median, NOT the mean (skewed data discriminates the two)", () => {
    // Right-skewed: an outlier pulls the mean up but the median holds.
    expect(median([1, 2, 3, 4, 10])).toBe(3); // mean would be 4
    expect(median([1, 2, 3, 100])).toBe(2.5); // mean would be 26.5
    // Unsorted input with an outlier — still the middle by value, not position.
    expect(median([100, 1, 2, 3])).toBe(2.5);
  });
});

describe("parseSessionJsonl", () => {
  test("sums usage, counts tool calls by name, and counts assistant turns", () => {
    const jsonl = [
      JSON.stringify({ message: { role: "user", content: [] } }),
      JSON.stringify({
        message: {
          role: "assistant",
          usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.005 } },
          content: [
            { type: "toolCall", name: "read_skill" },
            { type: "text" },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          usage: { input: 50, output: 10, totalTokens: 60, cost: { total: 0.002 } },
          content: [{ type: "toolCall", name: "read_skill" }],
        },
      }),
      "{ malformed",
    ].join("\n");

    const m = parseSessionJsonl(jsonl);
    expect(m.inputTokens).toBe(150);
    expect(m.outputTokens).toBe(30);
    expect(m.totalTokens).toBe(180);
    expect(m.cost).toBeCloseTo(0.007, 6);
    expect(m.toolCalls["read_skill"]).toBe(2);
    expect(m.turns).toBe(2);
  });
});

describe("summarize", () => {
  test("computes per-condition medians, speedup, and token reduction over measured runs", () => {
    // indices 0,1 are warm-up; 2,4,6 control; 3,5,7 harbor.
    // Each condition has a skewing outlier so median != mean: control wall times
    // are [10,10,40] (median 10, mean 20); harbor [5,5,20] (median 5, mean 10).
    // The asserted speedup/reduction only hold if the aggregate is the MEDIAN.
    const runs: BenchRun[] = [
      run(0, { wallTimeSeconds: 99 }), // warm-up control (excluded)
      run(1, { wallTimeSeconds: 99 }), // warm-up harbor (excluded)
      run(2, { wallTimeSeconds: 10, inputTokens: 1000 }),
      run(3, { wallTimeSeconds: 5, inputTokens: 400 }),
      run(4, { wallTimeSeconds: 10, inputTokens: 1000 }),
      run(5, { wallTimeSeconds: 5, inputTokens: 400 }),
      run(6, { wallTimeSeconds: 40, inputTokens: 4000 }), // control outlier
      run(7, { wallTimeSeconds: 20, inputTokens: 1600 }), // harbor outlier
    ];
    const s = summarize("bugfix", runs);
    expect(s.measuredRuns).toBe(6);
    expect(s.control?.medianWallTime).toBe(10); // median of [10,10,40]; mean would be 20
    expect(s.harbor?.medianWallTime).toBe(5); // median of [5,5,20]; mean would be 10
    expect(s.control?.medianInputTokens).toBe(1000); // median of [1000,1000,4000]; mean 2000
    expect(s.harbor?.medianInputTokens).toBe(400); // median of [400,400,1600]; mean ~800
    expect(s.speedup).toBe(2); // median 10 / median 5 (mean-based would be 2 also, but tokens below discriminate)
    expect(s.inputTokenReductionPct).toBeCloseTo(60, 6); // (1 - 400/1000)*100; mean-based ≈ 60 too → see medianInputTokens asserts
    expect(formatSummary(s)).toContain("2.00x faster");
  });

  test("empty / all-warmup input does not throw and yields null deltas", () => {
    const s = summarize("noop", [run(0), run(1)]);
    expect(s.measuredRuns).toBe(0);
    expect(s.control).toBeNull();
    expect(s.harbor).toBeNull();
    expect(s.speedup).toBeNull();
  });
});

describe("runBench (resilient end-to-end)", () => {
  test("completes with a stub agent and persists a loadable report", () => {
    // Use a harmless real binary ("true") as the agent so spawning succeeds.
    const summary = runBench(env(), { task: "bugfix", runs: 2, agent: "true", timeoutMs: 5000 });
    expect(summary.task).toBe("bugfix");
    expect(summary.totalRuns).toBe(2);
    // With runs=2 both are warm-up → no measured runs, but it must not throw.
    expect(summary.measuredRuns).toBe(0);

    const loaded = latestReport(env());
    expect(loaded?.task).toBe("bugfix");
  });

  test("a missing agent binary records failure instead of throwing", () => {
    const summary = runBench(env(), {
      task: "bugfix",
      runs: 4,
      agent: "__definitely_no_such_binary__",
      timeoutMs: 5000,
    });
    expect(summary.totalRuns).toBe(4);
    // measured runs exist (indices 2,3) and all failed → success rate 0
    expect(summary.control?.successRate).toBe(0);
  });
});
