/**
 * depersonalization.test.ts — Phase 6 ship gate: the stranger test, encoded.
 *
 * BUILD_BRIEF §3: a stranger must be able to clone, install, and run Harbor
 * learning NOTHING about the author. This scans the shippable product surface
 * (the non-test source that lands in the npm tarball) for machine DNA:
 *
 *   - `/Users/...` or `/home/<user>` absolute paths
 *   - real email addresses
 *   - the prototype's personal room taxonomy and personal MCP servers
 *
 * It is a pure-filesystem scan (no subprocess), so it is deterministic under the
 * `--randomize` gate. Test files are intentionally excluded: they carry NEGATIVE
 * assertions (`expect(x).not.toContain("/Users/")`) that would self-trip a naive
 * grep — and tests never ship anyway (see packaging.test.ts for the tarball proof).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

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

describe("de-personalization — shippable surface carries no machine DNA", () => {
  test("no /Users/ or /home/<user> absolute paths", () => {
    const hits: string[] = [];
    for (const f of SHIPPED) {
      const text = readFileSync(f, "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\/Users\/|\/home\/[a-z]/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  test("no real email addresses", () => {
    // Allow the generic placeholders that legitimately appear in templates/docs.
    const allow = /noreply|example\.(com|org)|\$\{|@anthropic|your-?email/i;
    const email = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const hits: string[] = [];
    for (const f of SHIPPED) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (email.test(line) && !allow.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  test("no personal room taxonomy or personal MCP servers", () => {
    const forbidden =
      /finance_real_estate|bookkeeping|quickbooks|superpowers|harwell|adammatar|supermetrics/i;
    const hits: string[] = [];
    for (const f of SHIPPED) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (forbidden.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
