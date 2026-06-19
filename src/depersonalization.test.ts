/**
 * depersonalization.test.ts — Phase 6 ship gate: the stranger test, encoded.
 *
 * BUILD_BRIEF §3: a stranger must be able to clone, install, and run Harbor
 * learning NOTHING about the author. This scans the shippable product surface
 * (the non-test source that lands in the npm tarball) for machine DNA:
 *
 *   - `/Users/...` or `/home/<user>` absolute paths   — structural, always on
 *   - real email addresses                            — structural, always on
 *   - any term in an OPTIONAL operator-private blocklist fixture
 *     (`.depers-blocklist.local.json`, gitignored)    — personal room /
 *     workflow / vendor names that must never ship.
 *
 * The blocklist fixture is deliberately NOT committed: a public clone has no
 * fixture, so this suite runs green for a stranger while the structural checks
 * still guard the universal leaks. On the operator's own machine the fixture is
 * present, so it additionally guards their personal terms. No personal term ever
 * lands in a committed file — not even as a negative assertion.
 *
 * Pure-filesystem scan (no subprocess), so it is deterministic under the
 * `--randomize` gate. Test files are intentionally excluded: they carry NEGATIVE
 * assertions (`expect(x).not.toContain("/Users/")`) that would self-trip a naive
 * grep — and tests never ship (see packaging.test.ts for the tarball proof).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const BLOCKLIST_FIXTURE = join(REPO, ".depers-blocklist.local.json");

/** Non-test `.ts` files under a dir — the product surface that ships. */
function productFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => f !== "test-setup.ts" && f !== "concurrency.worker.ts")
    .map((f) => join(dir, f));
}

const SHIPPED = [
  ...productFiles(join(REPO, "src")),
  ...productFiles(join(REPO, "integrations")),
  join(REPO, "README.md"),
  join(REPO, "LICENSE"),
  join(REPO, "package.json"),
];

/** Every line of every shipped file, tagged with its origin for failure output. */
function shippedLines(): Array<{ where: string; line: string }> {
  const out: Array<{ where: string; line: string }> = [];
  for (const f of SHIPPED) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => out.push({ where: `${f}:${i + 1}`, line }));
  }
  return out;
}

/**
 * The operator-private blocklist, if the gitignored fixture exists. Shape:
 * `{ "terms": ["term-a", "term-b", ...] }`. Returns `[]` in a public clone, so
 * the blocklist test runs green for a stranger.
 */
function localBlocklist(): string[] {
  if (!existsSync(BLOCKLIST_FIXTURE)) return [];
  const raw = JSON.parse(readFileSync(BLOCKLIST_FIXTURE, "utf8")) as { terms?: unknown };
  if (!Array.isArray(raw.terms)) return [];
  return raw.terms.filter((t): t is string => typeof t === "string" && t.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("de-personalization — shippable surface carries no machine DNA", () => {
  test("no /Users/ or /home/<user> absolute paths", () => {
    const hits = shippedLines()
      .filter(({ line }) => /\/Users\/|\/home\/[a-z]/.test(line))
      .map(({ where, line }) => `${where}: ${line.trim()}`);
    expect(hits, hits.join("\n")).toEqual([]);
  });

  test("no real email addresses", () => {
    // Allow the generic placeholders that legitimately appear in templates/docs.
    const allow = /noreply|example\.(com|org)|\$\{|@anthropic|your-?email/i;
    const email = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const hits = shippedLines()
      .filter(({ line }) => email.test(line) && !allow.test(line))
      .map(({ where, line }) => `${where}: ${line.trim()}`);
    expect(hits, hits.join("\n")).toEqual([]);
  });

  test("no term from the operator-private blocklist fixture (skipped if absent)", () => {
    const terms = localBlocklist();
    if (terms.length === 0) return; // public clone: only the structural checks apply
    const re = new RegExp(terms.map(escapeRegExp).join("|"), "i");
    const hits = shippedLines()
      .filter(({ line }) => re.test(line))
      .map(({ where, line }) => `${where}: ${line.trim()}`);
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
