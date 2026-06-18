/**
 * no-test-reads-the-live-machine.test.ts — isolation tripwire.
 *
 * Pins the soak-safety contract the Phase-4 determinism gate requires: the suite
 * must never touch the operator's real `~/.agent-env`, `~/rooms`, `~/.agents`, or
 * the repo tree. Two of those leaks are silent machine-default fallbacks the
 * auditor flagged; this file fails loudly if either regresses.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Config } from "./config.ts";
import { Environment } from "./env.ts";
import { scaffold } from "./skill-create.ts";

describe("live-machine isolation", () => {
  test("the bunfig preload is active — cwd is a throwaway sandbox, not the repo", () => {
    // If `bunfig.toml`'s `[test] preload` is removed or test-setup stops calling
    // process.chdir(), cwd reverts to the repo and this fails — the early warning
    // that the cwd-fallback offender is no longer contained.
    const cwd = process.cwd();
    expect(cwd).toContain("harbor-test-home-");
    expect(cwd.startsWith(tmpdir()) || cwd.startsWith("/private" + tmpdir())).toBe(true);
    expect(cwd).not.toContain("harbor-ts");
  });

  test("skill-create's cwd fallback lands in the sandbox, never the repo or real home", () => {
    // scaffold() with no workDir falls back to `process.cwd()/skills-in-progress`
    // (skill-create.ts). With the preload's chdir, that is the sandbox — so even a
    // test that forgets `workDir` cannot scribble into the git tree or the real
    // home. Exercise the actual fallback path and assert where it wrote.
    const root = mkdtempSync(join(tmpdir(), "harbor-iso-env-"));
    try {
      const env = new Environment(root, Config.defaults());
      const res = scaffold(env, "cwd-fallback-probe");
      try {
        // Positive containment is the proof: the fallback wrote under the sandbox
        // cwd (a `harbor-test-home-*` dir under the OS temp dir). Anything outside
        // — the repo tree or the real home — fails these by construction, with no
        // machine-specific literal hardcoded.
        expect(res.skillDir.startsWith(process.cwd())).toBe(true);
        expect(res.skillDir).toContain("harbor-test-home-");
        expect(res.skillDir.startsWith(tmpdir()) || res.skillDir.startsWith("/private" + tmpdir())).toBe(true);
        expect(res.skillDir).not.toContain("harbor-ts");
      } finally {
        rmSync(dirname(res.skillDir), { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
