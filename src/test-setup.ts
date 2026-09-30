/**
 * test-setup.ts — Bun test preload: isolate the suite from the live machine.
 *
 * Loaded via `bunfig.toml` `[test] preload` before any test file runs. It moves
 * the process working directory (and `$HOME`/`USERPROFILE`) to a single
 * throwaway temp dir so the machine-default fallbacks the auditor flagged cannot
 * reach the operator's real environment:
 *
 *   - `scaffold()` work dir → `process.cwd()/skills-in-progress` (skill-create.ts:261).
 *     `process.chdir()` below makes this land in the sandbox, in-process AND in
 *     any child process (Bun.spawn inherits the parent's cwd), instead of the
 *     repo tree — where a forgotten `workDir` would corrupt git state and cause
 *     "already exists" cross-test races.
 *
 * In-process `os.homedir()` is intentionally NOT relied upon for isolation: Bun
 * snapshots it at startup, so a runtime override is a no-op (and module
 * namespaces are read-only, so it cannot be patched). The guarantee that no test
 * reads the real `~/.agent-env` / `~/rooms` / `~/.agents/skills` comes instead
 * from every test threading an explicit `env`/`workDir` into the modules it calls
 * — see `no-test-reads-the-live-machine.test.ts`, which fails if any default-env
 * resolution would point at the real home. This preload is the cwd half of that
 * contract plus defense-in-depth for anything that reads the `HOME` env var.
 *
 * BUILD_BRIEF §7: the build must not perturb the live system under soak.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxHome = mkdtempSync(join(tmpdir(), "harbor-test-home-"));

process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome; // Windows parity
process.chdir(sandboxHome);

process.on("exit", () => {
  try {
    rmSync(sandboxHome, { recursive: true, force: true });
  } catch {
    // ignore — temp dir, reclaimed by the OS regardless
  }
});

/**
 * A test that leaves `process.exitCode` non-zero makes `bun test` exit 1 even though every
 * test passed — and assigning `undefined` back does NOT reset it in Bun, so a helper that
 * "restores" a saved `undefined` after running a failing CLI command leaks exactly that.
 * It passes or fails depending on which files run before it (CI's file order differs from
 * a laptop's), so make the leak a named failure instead of a mystery exit code.
 */
afterAll(() => {
  const leaked = process.exitCode;
  if (leaked) {
    process.exitCode = 0; // clear it so this file's report is the one that fails, not the whole run's exit code
    throw new Error(
      `a test in this file left process.exitCode = ${String(leaked)}. Restore it with \`process.exitCode = saved ?? 0\` ` +
        "(assigning undefined does not reset it in Bun).",
    );
  }
});
