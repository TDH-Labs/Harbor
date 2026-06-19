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
    // Defense-in-depth: the test-setup preload sandboxes cwd. The primary
    // isolation guarantee is that every test threads explicit env/root paths;
    // this tripwire catches the case where the preload fails to fire.
    const cwd = process.cwd();
    expect(cwd).toContain("harbor-test-home-");
    expect(cwd.startsWith(tmpdir()) || cwd.startsWith("/private" + tmpdir())).toBe(true);
    expect(cwd).not.toContain("harbor-ts");
  });

  test("skill-create's fallback lands under env.dataDir, never the repo or real home", () => {
    // scaffold() with no workDir falls back to env.dataDir/skills-in-progress
    // (skill-create.ts:261). No ambient cwd coupling — the env carries its own
    // root, so a test that forgets `workDir` cannot scribble into the git tree
    // or the real home. Exercise the actual fallback path and assert containment.
    const root = mkdtempSync(join(tmpdir(), "harbor-iso-env-"));
    try {
      const env = new Environment(root, Config.defaults());
      const res = scaffold(env, "cwd-fallback-probe");
      try {
        // The fallback writes under env.dataDir, which is under the test's temp
        // root — NOT process.cwd(). Containment under root is the proof no
        // real home or repo tree was touched.
        expect(res.skillDir.startsWith(root)).toBe(true);
        expect(res.skillDir).toContain("skills-in-progress");
        expect(res.skillDir).not.toContain("harbor-ts");
        expect(res.skillDir).not.toContain(join("Users", "ai"));
      } finally {
        rmSync(dirname(res.skillDir), { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
