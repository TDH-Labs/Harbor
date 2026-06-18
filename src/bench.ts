/**
 * bench.ts — Benchmark harness comparing a "control" vs "harbor" agent condition.
 *
 * Runs an agent under two conditions in an interleaved design, parses each run's
 * session JSONL for token/cost/tool metrics, discards warm-up runs, and reports
 * median statistics. Port of the Python prototype's `bench.py`.
 *
 * Behavioral-fidelity notes (from `bench.py`, where SPEC_TS is silent):
 *   - Interleaved ABAB design: even run index → "control", odd → "harbor"
 *     ({@link conditionFor}).
 *   - Warm-up discard: the first {@link WARMUP} runs are excluded from the medians
 *     ({@link isMeasured}).
 *   - Statistics are medians per metric, plus min/max wall time, success rate,
 *     a speedup ratio (control_time / harbor_time) and an input-token reduction %.
 *   - Session JSONL is parsed per line as JSON; "message" events carry
 *     `usage.{input,output,totalTokens}` and `usage.cost.total`; tool calls are
 *     `content[]` entries with `type === "toolCall"` counted by `name`; each
 *     assistant message is one turn.
 *   - Results persist to `<state_dir>/benchmarks/bench_<unixSeconds>.json`.
 *
 * The subprocess runner uses `Bun.spawn` and is resilient: a missing agent binary
 * records a failed run rather than throwing, so `bench run` always completes. The
 * stats math is pure and exported for deterministic testing without spawning.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Environment } from "./env.ts";

/** Number of leading warm-up runs excluded from the medians. */
export const WARMUP = 2;

export type Condition = "control" | "harbor";

/** ABAB interleave: even index → control, odd → harbor. */
export function conditionFor(index: number): Condition {
  return index % 2 === 0 ? "control" : "harbor";
}

/** Whether a run index counts toward the medians (warm-up runs don't). */
export function isMeasured(index: number): boolean {
  return index >= WARMUP;
}

// ── Run + result types ────────────────────────────────────────────────────────

export interface BenchRun {
  index: number;
  condition: Condition;
  wallTimeSeconds: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  toolCalls: Record<string, number>;
  turns: number;
  success: boolean;
  exitCode: number;
}

export interface ConditionStats {
  condition: Condition;
  count: number;
  medianWallTime: number;
  minWallTime: number;
  maxWallTime: number;
  medianInputTokens: number;
  medianOutputTokens: number;
  medianTotalTokens: number;
  medianCost: number;
  medianToolCalls: number;
  successRate: number;
}

export interface BenchSummary {
  task: string;
  totalRuns: number;
  measuredRuns: number;
  control: ConditionStats | null;
  harbor: ConditionStats | null;
  /** control_time / harbor_time (>1 ⇒ harbor faster). Null if either side empty. */
  speedup: number | null;
  /** (1 - harbor_input / control_input) * 100. Null if either side empty. */
  inputTokenReductionPct: number | null;
}

// ── Pure stats ────────────────────────────────────────────────────────────────

/** Median of a numeric list (mean of the two middle values for even length). 0 if empty. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function totalToolCalls(run: BenchRun): number {
  return Object.values(run.toolCalls).reduce((a, b) => a + b, 0);
}

function statsFor(condition: Condition, runs: BenchRun[]): ConditionStats | null {
  const subset = runs.filter((r) => r.condition === condition);
  if (subset.length === 0) return null;
  const wall = subset.map((r) => r.wallTimeSeconds);
  const successes = subset.filter((r) => r.success).length;
  return {
    condition,
    count: subset.length,
    medianWallTime: median(wall),
    minWallTime: Math.min(...wall),
    maxWallTime: Math.max(...wall),
    medianInputTokens: median(subset.map((r) => r.inputTokens)),
    medianOutputTokens: median(subset.map((r) => r.outputTokens)),
    medianTotalTokens: median(subset.map((r) => r.totalTokens)),
    medianCost: median(subset.map((r) => r.cost)),
    medianToolCalls: median(subset.map(totalToolCalls)),
    successRate: successes / subset.length,
  };
}

/** Aggregate measured runs (warm-up already excluded) into a summary. */
export function summarize(task: string, allRuns: BenchRun[]): BenchSummary {
  const measured = allRuns.filter((r) => isMeasured(r.index));
  const control = statsFor("control", measured);
  const harbor = statsFor("harbor", measured);
  let speedup: number | null = null;
  let inputTokenReductionPct: number | null = null;
  if (control && harbor && harbor.medianWallTime > 0) {
    speedup = control.medianWallTime / harbor.medianWallTime;
  }
  if (control && harbor && control.medianInputTokens > 0) {
    inputTokenReductionPct = (1 - harbor.medianInputTokens / control.medianInputTokens) * 100;
  }
  return {
    task,
    totalRuns: allRuns.length,
    measuredRuns: measured.length,
    control,
    harbor,
    speedup,
    inputTokenReductionPct,
  };
}

// ── Session JSONL parsing ─────────────────────────────────────────────────────

export interface SessionMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  toolCalls: Record<string, number>;
  turns: number;
}

interface UsageBlock {
  input?: number;
  output?: number;
  totalTokens?: number;
  cost?: { total?: number };
}
interface ContentBlock {
  type?: string;
  name?: string;
}
interface MessageEvent {
  message?: {
    role?: string;
    usage?: UsageBlock;
    content?: ContentBlock[];
  };
}

/** Parse agent session JSONL text into aggregate token / cost / tool metrics. */
export function parseSessionJsonl(text: string): SessionMetrics {
  const metrics: SessionMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    toolCalls: {},
    turns: 0,
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: MessageEvent;
    try {
      event = JSON.parse(trimmed) as MessageEvent;
    } catch {
      continue; // skip malformed lines
    }
    const msg = event.message;
    if (!msg) continue;
    const usage = msg.usage;
    if (usage) {
      metrics.inputTokens += usage.input ?? 0;
      metrics.outputTokens += usage.output ?? 0;
      metrics.totalTokens += usage.totalTokens ?? 0;
      metrics.cost += usage.cost?.total ?? 0;
    }
    if (msg.role === "assistant") metrics.turns += 1;
    for (const block of msg.content ?? []) {
      if (block.type === "toolCall" && block.name) {
        metrics.toolCalls[block.name] = (metrics.toolCalls[block.name] ?? 0) + 1;
      }
    }
  }
  return metrics;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export interface BenchOptions {
  task?: string;
  runs?: number;
  /** Agent binary to invoke (configurable — no machine-specific default baked in). */
  agent?: string;
  /** Prompt passed to the agent for each run. */
  prompt?: string;
  /** Per-run timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_PROMPT = "Reply with the single word: ok";

/** Directory where bench result JSON files are written. */
export function benchmarksDir(env: Environment): string {
  return join(env.stateDir, "benchmarks");
}

function sessionDirFor(env: Environment): string {
  return join(env.stateDir, "bench_sessions");
}

/** Locate the newest file created in `dir` that isn't in `before`. */
function newestNewFile(dir: string, before: Set<string>): string | null {
  if (!existsSync(dir)) return null;
  let newest: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (before.has(path)) continue;
    try {
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    } catch {
      // skip
    }
  }
  return newest?.path ?? null;
}

/**
 * Execute a single agent run under the given condition. Resilient: a spawn
 * failure (e.g. missing agent binary) is recorded as a failed run, never thrown.
 */
export function runOne(
  env: Environment,
  index: number,
  options: Required<Pick<BenchOptions, "agent" | "prompt" | "timeoutMs">>,
): BenchRun {
  const condition = conditionFor(index);
  const sessionDir = sessionDirFor(env);
  mkdirSync(sessionDir, { recursive: true });
  const before = new Set(existsSync(sessionDir) ? readdirSync(sessionDir).map((n) => join(sessionDir, n)) : []);

  // Harbor condition runs with skill access gated off ("--no-skills"); control runs plain.
  const argv = [options.agent];
  if (condition === "harbor") argv.push("--no-skills");
  argv.push("-p", options.prompt, "--session-dir", sessionDir);

  const run: BenchRun = {
    index,
    condition,
    wallTimeSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    toolCalls: {},
    turns: 0,
    success: false,
    exitCode: -1,
  };

  const start = performance.now();
  try {
    const proc = Bun.spawnSync(argv, { timeout: options.timeoutMs, stdout: "pipe", stderr: "pipe" });
    run.exitCode = proc.exitCode ?? -1;
    run.success = proc.exitCode === 0;
  } catch {
    run.success = false;
    run.exitCode = -1;
  }
  run.wallTimeSeconds = Math.round(((performance.now() - start) / 1000) * 100) / 100;

  const sessionFile = newestNewFile(sessionDir, before);
  if (sessionFile) {
    try {
      const metrics = parseSessionJsonl(readFileSync(sessionFile, "utf8"));
      run.inputTokens = metrics.inputTokens;
      run.outputTokens = metrics.outputTokens;
      run.totalTokens = metrics.totalTokens;
      run.cost = metrics.cost;
      run.toolCalls = metrics.toolCalls;
      run.turns = metrics.turns;
    } catch {
      // leave zeroes
    }
  }
  return run;
}

/** Run the full interleaved benchmark, persist results, and return the summary. */
export function runBench(env: Environment, options: BenchOptions = {}): BenchSummary {
  const task = options.task ?? "all";
  const runs = options.runs ?? 10;
  const opts = {
    agent: options.agent ?? "pi",
    prompt: options.prompt ?? DEFAULT_PROMPT,
    timeoutMs: options.timeoutMs ?? 300_000,
  };

  const all: BenchRun[] = [];
  for (let i = 0; i < runs; i++) all.push(runOne(env, i, opts));

  const summary = summarize(task, all);
  const dir = benchmarksDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `bench_${Math.floor(Date.now() / 1000)}.json`);
  writeFileSync(path, JSON.stringify({ task, runs: all, summary }, null, 2));
  return summary;
}

/** Load the most recent persisted benchmark summary (for `bench report`). */
export function latestReport(env: Environment): BenchSummary | null {
  const dir = benchmarksDir(env);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((n) => n.startsWith("bench_") && n.endsWith(".json"))
    .sort();
  const last = files.at(-1);
  if (!last) return null;
  try {
    const data = JSON.parse(readFileSync(join(dir, last), "utf8")) as { summary: BenchSummary };
    return data.summary;
  } catch {
    return null;
  }
}

/** Render a benchmark summary as plain text (CLI output). */
export function formatSummary(s: BenchSummary): string {
  const lines = [`=== ${s.task} — median results (${s.measuredRuns}/${s.totalRuns} measured) ===`];
  for (const stats of [s.control, s.harbor]) {
    if (!stats) continue;
    lines.push(
      `  ${stats.condition}:`,
      `    time:   median ${stats.medianWallTime}s (min ${stats.minWallTime}, max ${stats.maxWallTime})`,
      `    tokens: in ${stats.medianInputTokens} / out ${stats.medianOutputTokens} / total ${stats.medianTotalTokens}`,
      `    cost:   $${stats.medianCost.toFixed(4)}`,
      `    tools:  ${stats.medianToolCalls} calls`,
      `    success: ${Math.round(stats.successRate * 100)}% (${stats.count} runs)`,
    );
  }
  if (s.speedup !== null) {
    lines.push(`  speed:  ${s.speedup.toFixed(2)}x ${s.speedup >= 1 ? "faster" : "slower"} with harbor`);
  }
  if (s.inputTokenReductionPct !== null) {
    const p = s.inputTokenReductionPct;
    lines.push(`  tokens: ${Math.abs(p).toFixed(1)}% ${p >= 0 ? "fewer" : "more"} input tokens with harbor`);
  }
  return lines.join("\n");
}
