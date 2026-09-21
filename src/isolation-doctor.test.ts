/**
 * isolation-doctor.test.ts — the report-only isolation analysis.
 *
 * Soak-safe: every test builds a pool + config under a mkdtemp root. No test
 * reads the live machine's ~/.agents/skills.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { analyzeIsolation, checkRoomHygiene, formatReport } from "./isolation-doctor.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-isodoc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(rooms: Record<string, unknown> = {}): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { skills_dir: join(dir, "pool") }, skills: { rooms } }));
  return new Environment(dir, cfg);
}

function writeSkill(name: string, body: string): void {
  const d = join(dir, "pool", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}`);
}

describe("analyzeIsolation", () => {
  test("reports the self-asserted-room finding unconditionally — it is always true today", () => {
    const r = analyzeIsolation(env({ ops: { skills: [] } }));
    const selfAsserted = r.findings.find((f) => f.title.includes("self-asserted"));
    expect(selfAsserted).toBeDefined();
    expect(selfAsserted!.severity).toBe("warn");
  });

  test("flags a group/other-readable pool as a warning", () => {
    writeSkill("aa", "# aa");
    chmodSync(join(dir, "pool"), 0o755); // owner + group/other read
    const r = analyzeIsolation(env({ ops: { skills: ["aa"] } }));
    expect(r.poolWorldOrGroupReadable).toBe(true);
    expect(r.findings.some((f) => f.severity === "warn" && f.title.includes("readable beyond"))).toBe(true);
  });

  test("an owner-only pool is info, not warn, but still notes the same-uid caveat", () => {
    writeSkill("aa", "# aa");
    chmodSync(join(dir, "pool"), 0o700);
    const r = analyzeIsolation(env({ ops: { skills: ["aa"] } }));
    expect(r.poolWorldOrGroupReadable).toBe(false);
    const f = r.findings.find((x) => x.title.includes("owner-only"));
    expect(f?.severity).toBe("info");
    expect(f?.detail).toContain("distinct uid");
  });

  // The load-bearing distinction for the whole isolation plan: host-bound skills
  // cannot be containerized, so the doctor must find them BEFORE anyone tries.
  test("detects host-access skills and leaves plain skills alone", () => {
    writeSkill("imessage", "Send iMessages via the `imsg` CLI. Uses osascript to drive Messages.");
    writeSkill("apple-notes", "Manage Apple Notes via the memo CLI.");
    writeSkill("desktop", "Drive the desktop with computer-use and screenshot.");
    writeSkill("airtable", "Airtable REST API via curl. Records CRUD.");
    writeSkill("linear", "Linear GraphQL via curl.");
    const r = analyzeIsolation(
      env({ productivity: { skills: ["imessage", "apple-notes", "desktop", "airtable", "linear"] } }),
    );
    const names = r.hostBound.map((h) => h.name).sort();
    expect(names).toEqual(["apple-notes", "desktop", "imessage"]);
    // airtable/linear are pure-API and must NOT be flagged.
    expect(names).not.toContain("airtable");
    expect(names).not.toContain("linear");
    // each host-bound skill is labeled with its room and the signals found
    const imsg = r.hostBound.find((h) => h.name === "imessage")!;
    expect(imsg.room).toBe("productivity");
    expect(imsg.signals.length).toBeGreaterThan(0);
  });

  test("word-boundary matching does not false-positive on lookalikes", () => {
    // 'recompute' must not trigger the 'computer-use' signal; 'says' must not
    // trigger the `say -v` voice signal.
    writeSkill("mathy", "This skill will recompute totals and say hello politely.");
    const r = analyzeIsolation(env({ ops: { skills: ["mathy"] } }));
    expect(r.hostBound).toEqual([]);
  });

  test("a missing pool is reported, not thrown", () => {
    const r = analyzeIsolation(env({}));
    expect(r.poolExists).toBe(false);
    expect(r.totalSkills).toBe(0);
    expect(() => formatReport(r)).not.toThrow();
  });

  test("formatReport always states it changed nothing", () => {
    writeSkill("aa", "# aa");
    const text = formatReport(analyzeIsolation(env({ ops: { skills: ["aa"] } })));
    expect(text).toContain("REPORT ONLY");
    expect(text.toLowerCase()).toContain("nothing was changed");
  });

  test("checkRoomHygiene flags dirty git repository in room directory and warns on worktree isolation", () => {
    const roomPath = join(dir, "rooms", "ops");
    mkdirSync(roomPath, { recursive: true });
    // Initialize git repository
    Bun.spawnSync(["git", "init"], { cwd: roomPath });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: roomPath });
    Bun.spawnSync(["git", "config", "user.name", "Tester"], { cwd: roomPath });
    writeFileSync(join(roomPath, "tracked.txt"), "hello");
    Bun.spawnSync(["git", "add", "."], { cwd: roomPath });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: roomPath });

    // Add uncommitted file
    writeFileSync(join(roomPath, "dirty.txt"), "uncommitted");

    const e = env({ ops: { skills: [] } });
    const hygiene = checkRoomHygiene(e);
    expect(hygiene.length).toBe(1);
    expect(hygiene[0]?.room).toBe("ops");
    expect(hygiene[0]?.dirtyCount).toBe(1);

    const r = analyzeIsolation(e);
    const finding = r.findings.find((f) => f.title.includes("uncommitted changes"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warn");
    expect(finding!.detail).toContain("git worktrees");
  });

  test("checkRoomHygiene reports clean repository as info finding", () => {
    const roomPath = join(dir, "rooms", "ops");
    mkdirSync(roomPath, { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: roomPath });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: roomPath });
    Bun.spawnSync(["git", "config", "user.name", "Tester"], { cwd: roomPath });
    writeFileSync(join(roomPath, "tracked.txt"), "hello");
    Bun.spawnSync(["git", "add", "."], { cwd: roomPath });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: roomPath });

    const e = env({ ops: { skills: [] } });
    const hygiene = checkRoomHygiene(e);
    expect(hygiene.length).toBe(1);
    expect(hygiene[0]?.dirtyCount).toBe(0);

    const r = analyzeIsolation(e);
    const finding = r.findings.find((f) => f.title.includes("working trees are clean"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
  });
});
