/**
 * packaging.test.ts — Phase 6 ship gate: the package surface is what ships.
 *
 * Three guarantees, all asserted against the REAL repo (not a fixture), because
 * the thing under test is this package's own manifest:
 *
 *   1. The `bin` entry and every `exports` subpath resolve to a real, importable
 *      file — a published `harbor-tugboat` whose bin or subpath 404s is broken on install.
 *   2. `npm pack` ships ONLY the shippable surface — no `*.test.ts`, no
 *      `test-setup.ts`, no `concurrency.worker.ts`, no `PHASE*_NOTES.md`, no
 *      `bunfig.toml`. The files allowlist in package.json is the mechanism; this
 *      test is the proof it holds (a stranger's tarball reveals nothing internal).
 *   3. `init` + `setup` build the environment under an EXPLICIT `--root`, never
 *      the home default — and a temp `$HOME` is left untouched, the same soak
 *      safety the `no-test-reads-the-live-machine` tripwire pins.
 *
 * Soak safety: the `npm pack --dry-run` and package.json reads are read-only; the
 * CLI flow threads an explicit `--root` and a throwaway `$HOME`, so nothing here
 * can reach the operator's real `~/.agent-env` (BUILD_BRIEF §7).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Repo root: this file lives in `src/`. */
const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");

interface PackageJson {
  name: string;
  version: string;
  bin: Record<string, string>;
  exports: Record<string, string>;
  files: string[];
}

function readPkg(): PackageJson {
  return JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as PackageJson;
}

describe("package manifest — bin + exports resolve", () => {
  const pkg = readPkg();

  test("name is harbor-tugboat and version is a clean semver", () => {
    expect(pkg.name).toBe("harbor-tugboat");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the bin command stays named harbor (product name is unchanged)", () => {
    expect(Object.keys(pkg.bin)).toEqual(["harbor"]);
  });

  test("the bin entry points at a file that exists", () => {
    const rel = pkg.bin.harbor;
    expect(rel).toBeTruthy();
    expect(existsSync(join(REPO, rel as string))).toBe(true);
  });

  test("every exports subpath resolves to an existing file", () => {
    for (const [subpath, rel] of Object.entries(pkg.exports)) {
      expect(existsSync(join(REPO, rel)), `${subpath} → ${rel}`).toBe(true);
    }
  });

  test("every exports subpath is importable without throwing", async () => {
    for (const rel of Object.values(pkg.exports)) {
      const mod = (await import(join(REPO, rel))) as Record<string, unknown>;
      expect(mod, rel).toBeObject();
    }
  });

  test("the documented core symbols are importable from the package root", async () => {
    const root = (await import(join(REPO, pkg.exports["."] as string))) as Record<string, unknown>;
    for (const sym of ["createSession", "checkBudget", "spendBudget", "gate", "audit", "evict", "spawn"]) {
      expect(typeof root[sym], sym).not.toBe("undefined");
    }
  });
});

describe("npm pack manifest — only the shippable surface", () => {
  // `npm pack --dry-run --json` reports the exact tarball contents without writing.
  const proc = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  const parsed = JSON.parse(proc.stdout.toString()) as Array<{ files: Array<{ path: string }> }>;
  const files = (parsed[0]?.files ?? []).map((f) => f.path);

  test("npm pack succeeded and reported a non-empty file list", () => {
    expect(proc.exitCode).toBe(0);
    expect(files.length).toBeGreaterThan(0);
  });

  test("ships no test files, scaffolding, or internal notes", () => {
    const forbidden = files.filter(
      (f) =>
        /\.test\.ts$/.test(f) ||
        f === "src/test-setup.ts" ||
        f === "src/concurrency.worker.ts" ||
        /(^|\/)PHASE\d.*\.md$/.test(f) ||
        /(^|\/)REVIEW_\d/.test(f) ||
        f === "bunfig.toml" ||
        f.endsWith(".tgz") ||
        f.startsWith("dist/"),
    );
    expect(forbidden, `forbidden files in tarball: ${forbidden.join(", ")}`).toEqual([]);
  });

  test("ships the product surface: cli, index, all integrations, docs, license", () => {
    expect(files).toContain("src/cli.ts");
    expect(files).toContain("src/index.ts");
    expect(files).toContain("integrations/mcp-server.ts");
    expect(files).toContain("integrations/pi.ts");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).toContain("package.json");
  });

  test("every src/*.ts in the tarball is a product module, never a test", () => {
    const srcTs = files.filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
    expect(srcTs.length).toBeGreaterThan(10);
    for (const f of srcTs) expect(f).not.toMatch(/\.test\.ts$/);
  });
});

describe("clean-checkout flow — init + setup target an explicit root", () => {
  test("init then setup build the tree under --root and leave $HOME untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-pack-root-"));
    const home = mkdtempSync(join(tmpdir(), "harbor-pack-home-"));
    // Thread an explicit, throwaway $HOME: if init/setup ever resolved the home
    // default instead of --root, a `.agent-env` would appear under it. It must not.
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    try {
      const init = Bun.spawnSync(["bun", CLI, "init", "--root", root], { env, stdout: "pipe", stderr: "pipe" });
      expect(init.stderr.toString() + init.stdout.toString()).toContain("init:");
      expect(init.exitCode).toBe(0);

      const setup = Bun.spawnSync(["bun", CLI, "setup", "--root", root], { env, stdout: "pipe", stderr: "pipe" });
      expect(setup.exitCode).toBe(0);
      expect(setup.stdout.toString()).toContain("setup:");

      // The tree is built under the explicit root.
      expect(existsSync(join(root, "agent_map.md"))).toBe(true);
      expect(existsSync(join(root, "workspace"))).toBe(true);
      expect(existsSync(join(root, "rooms"))).toBe(true);
      expect(existsSync(join(root, ".agent-env"))).toBe(true);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("<!-- agent-env:sync -->");

      // setup is idempotent — a second run creates zero new dirs.
      const again = Bun.spawnSync(["bun", CLI, "setup", "--root", root], { env, stdout: "pipe", stderr: "pipe" });
      expect(again.exitCode).toBe(0);
      expect(again.stdout.toString()).toContain("created 0 dir(s)");

      // The home default was NEVER touched: no state dir under the throwaway HOME.
      expect(existsSync(join(home, ".agent-env"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
