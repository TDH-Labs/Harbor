/**
 * sensitivity.test.ts — labels and token ceilings, from the pure rules up to a
 * real (in-process) HTTP session.
 *
 * The property under test: a token with `--max-sensitivity` is never HANDED a
 * skill above that ceiling or a skill nobody labeled — not by read_skill, not by
 * activate_skill, and not by leaking its name through list/search/route — and a
 * token without a ceiling behaves exactly as before labels existed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "citty";

import { DEFAULTS, Config, deepMerge } from "./config.ts";
import { main } from "./cli.ts";
import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";
import { createServerHandler, type ServerHandler } from "./http-server.ts";
import { auditRead } from "./isolation.ts";
import { labelReport, setRoomLabel, setSkillLabel } from "./labels.ts";
import {
  coerceLabel,
  effectiveSensitivity,
  isInvalidLabel,
  SENSITIVITIES,
  withinCeiling,
  type Sensitivity,
} from "./sensitivity.ts";
import { ControlPlane, TenantError } from "./tenants.ts";

let dir: string;
let cp: ControlPlane;
let handler: ServerHandler | undefined;
const savedRouter = process.env.HARBOR_SYSTEM_ONE_URL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-sens-"));
  cp = new ControlPlane(join(dir, "data"));
  process.env.HARBOR_SYSTEM_ONE_URL = "http://127.0.0.1:59992"; // never a router the developer runs
});
afterEach(() => {
  handler?.close();
  handler = undefined;
  closeAllDbs();
  Environment.unlockDefault();
  if (savedRouter === undefined) delete process.env.HARBOR_SYSTEM_ONE_URL;
  else process.env.HARBOR_SYSTEM_ONE_URL = savedRouter;
  rmSync(dir, { recursive: true, force: true });
});

const cfgWith = (skills: Record<string, unknown>): Config => new Config(deepMerge(DEFAULTS, { skills }));

// ── the pure rules ───────────────────────────────────────────────────────────

describe("label rules", () => {
  test("coerceLabel: a tier is itself, absent is unlabeled, anything else present is restricted", () => {
    for (const t of SENSITIVITIES) expect(coerceLabel(t)).toBe(t);
    expect(coerceLabel(undefined)).toBeNull();
    expect(coerceLabel(null)).toBeNull();
    for (const bad of ["publik", "PUBLIC", "", " public", 0, 1, true, false, {}, [], ["public"]]) {
      expect(coerceLabel(bad), JSON.stringify(bad)).toBe("restricted");
      expect(isInvalidLabel(bad), JSON.stringify(bad)).toBe(true);
    }
    expect(isInvalidLabel(undefined)).toBe(false);
    expect(isInvalidLabel("internal")).toBe(false);
  });

  test("withinCeiling: the full table", () => {
    const labels: Array<Sensitivity | null> = [null, "public", "internal", "restricted"];
    const ceilings: Array<Sensitivity | null> = [null, "public", "internal", "restricted"];
    const expected: Record<string, boolean> = {
      // ceiling none: everything, unlabeled included
      "none/none": true, "public/none": true, "internal/none": true, "restricted/none": true,
      // ceiling public
      "none/public": false, "public/public": true, "internal/public": false, "restricted/public": false,
      // ceiling internal
      "none/internal": false, "public/internal": true, "internal/internal": true, "restricted/internal": false,
      // ceiling restricted: labeled anything, but never unlabeled
      "none/restricted": false, "public/restricted": true, "internal/restricted": true, "restricted/restricted": true,
    };
    for (const l of labels) {
      for (const c of ceilings) {
        expect(withinCeiling(l, c), `${l ?? "none"}/${c ?? "none"}`).toBe(expected[`${l ?? "none"}/${c ?? "none"}`] as boolean);
      }
    }
  });

  test("effectiveSensitivity: a per-skill override beats the room default, which beats nothing", () => {
    const cfg = cfgWith({
      rooms: { legal: { skills: ["a", "b", "c"], sensitivity: "internal" }, plain: { skills: ["d"] } },
      skill_sensitivity: { b: "restricted", c: "public" },
    });
    expect(effectiveSensitivity(cfg, "legal", "a")).toBe("internal"); // room default
    expect(effectiveSensitivity(cfg, "legal", "b")).toBe("restricted"); // override raises
    expect(effectiveSensitivity(cfg, "legal", "c")).toBe("public"); // override lowers (the operator's call)
    expect(effectiveSensitivity(cfg, "plain", "d")).toBeNull(); // nothing anywhere
  });

  test("a bad value at either source fails closed, and a bad override does not fall back to the room", () => {
    const cfg = cfgWith({
      rooms: { r: { skills: ["x", "y"], sensitivity: "public" }, s: { skills: ["z"], sensitivity: "publik" } },
      skill_sensitivity: { y: "internl" },
    });
    expect(effectiveSensitivity(cfg, "r", "x")).toBe("public");
    expect(effectiveSensitivity(cfg, "r", "y")).toBe("restricted"); // NOT the room's "public"
    expect(effectiveSensitivity(cfg, "s", "z")).toBe("restricted");
  });

  test("a skill the room does not list takes the strictest label of the rooms that do, and unlabeled if any is", () => {
    const cfg = cfgWith({
      rooms: {
        me: { skills: ["mine"], sensitivity: "public" },
        a: { skills: ["shared"], sensitivity: "internal" },
        b: { skills: ["shared"], sensitivity: "restricted" },
        c: { skills: ["mixed"], sensitivity: "public" },
        d: { skills: ["mixed"] }, // unlabeled
        x: { skills: ["reversed"], sensitivity: "restricted" }, // strictest listed FIRST
        y: { skills: ["reversed"], sensitivity: "internal" },
      },
    });
    // as if reached through an approved cross-room grant: `me` does not list them
    expect(effectiveSensitivity(cfg, "me", "shared")).toBe("restricted"); // not me's "public"
    expect(effectiveSensitivity(cfg, "me", "reversed")).toBe("restricted"); // whichever order the rooms come in
    expect(effectiveSensitivity(cfg, "me", "mixed")).toBeNull();
    expect(effectiveSensitivity(cfg, "me", "nobody-lists-this")).toBeNull();
    expect(effectiveSensitivity(cfg, "a", "shared")).toBe("internal"); // its own room: its own label
  });

  test("a label cannot come from the skill itself", () => {
    // Written by whoever authored the skill, it would be the one party a label must not trust.
    const cfg = cfgWith({ rooms: { r: { skills: ["x"] } } });
    expect(effectiveSensitivity(cfg, "r", "x")).toBeNull();
    expect(Object.keys(cfg.data.skills)).not.toContain("skill_labels");
  });
});

// ── editing labels ───────────────────────────────────────────────────────────

function tenantWith(rooms: Record<string, string[]>, skillNames: string[], extraToml = ""): Environment {
  cp.createTenant("acme");
  const root = cp.tenantRoot("acme");
  const toml =
    `[paths]\nhome = ${JSON.stringify(root)}\n\n` +
    Object.entries(rooms)
      .map(([r, s]) => `[skills.rooms.${r}]\nskills = ${JSON.stringify(s)}\n`)
      .join("\n") + extraToml;
  writeFileSync(join(root, ".agent-env", "config.toml"), toml);
  for (const name of skillNames) {
    const d = join(root, ".agents", "skills", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: About ${name}\n---\n\n# ${name}\n`);
  }
  return cp.tenantEnvironment("acme");
}
const reload = (): Environment => Environment.load(cp.tenantConfigPath("acme"));

describe("harbor label: editing and reporting", () => {
  test("set/clear a room default and a skill override; both are idempotent", () => {
    const env = tenantWith({ legal: ["nda", "memo"] }, ["nda", "memo"]);
    expect(setRoomLabel(env, "legal", "internal").changed).toBe(true);
    expect(setRoomLabel(reload(), "legal", "internal").changed).toBe(false);
    expect(setSkillLabel(reload(), "memo", "restricted").changed).toBe(true);
    expect(setSkillLabel(reload(), "memo", "restricted").changed).toBe(false);

    const cfg = reload().config;
    expect(effectiveSensitivity(cfg, "legal", "nda")).toBe("internal");
    expect(effectiveSensitivity(cfg, "legal", "memo")).toBe("restricted");

    expect(setSkillLabel(reload(), "memo", null).changed).toBe(true);
    expect(setSkillLabel(reload(), "memo", null).changed).toBe(false);
    expect(setRoomLabel(reload(), "legal", null).changed).toBe(true);
    expect(effectiveSensitivity(reload().config, "legal", "memo")).toBeNull();
    // the room's skill list survived every edit
    expect(reload().config.roomSkills.legal?.skills).toEqual(["nda", "memo"]);
  });

  test("refuses what would be a silent no-op: a typo'd tier, an unknown room, a skill not in the pool", () => {
    const env = tenantWith({ legal: ["nda"] }, ["nda"]);
    expect(() => setRoomLabel(env, "legal", "secret")).toThrow(/invalid tier/);
    expect(() => setSkillLabel(env, "nda", "Internal")).toThrow(/invalid tier/);
    expect(() => setRoomLabel(env, "ghost", "public")).toThrow(/not found/);
    expect(() => setSkillLabel(env, "not-installed", "public")).toThrow(/not in the pool/);
    for (const name of ["__proto__", "../x", "a/b", "", ".hidden", "constructor "]) {
      expect(() => setSkillLabel(env, name, "public"), JSON.stringify(name)).toThrow();
    }
    expect(() => setRoomLabel(env, "../legal", "public")).toThrow(/invalid room name/);
    // nothing was written by any of the refusals
    expect(readFileSync(cp.tenantConfigPath("acme"), "utf8")).not.toContain("sensitivity");
  });

  test("the report shows source, unlabeled count, invalid values and stray overrides", () => {
    const env = tenantWith(
      { legal: ["nda", "memo"], ops: ["runbook"] },
      ["nda", "memo", "runbook"],
      `\n[skills.skill_sensitivity]\nmemo = "restricted"\nghost = "public"\nrunbook = "publik"\n`,
    );
    setRoomLabel(env, "legal", "internal");
    const r = labelReport(reload());
    const row = (room: string, skill: string) => r.rows.find((x) => x.room === room && x.skill === skill);
    expect(row("legal", "nda")).toMatchObject({ label: "internal", source: "room", invalid: false });
    expect(row("legal", "memo")).toMatchObject({ label: "restricted", source: "skill", invalid: false });
    expect(row("ops", "runbook")).toMatchObject({ label: "restricted", source: "skill", invalid: true });
    expect(r.invalidSkills).toEqual(["runbook"]);
    expect(r.strayOverrides).toEqual(["ghost"]);
    expect(r.unlabeled).toBe(0);
    setSkillLabel(reload(), "runbook", null);
    expect(labelReport(reload()).unlabeled).toBe(1); // ops/runbook is now unlabeled, and the report says so
  });
});

// ── token ceilings in the control plane ──────────────────────────────────────

describe("token ceilings", () => {
  beforeEach(() => {
    tenantWith({ team: ["s"] }, ["s"]);
  });

  test("a ceiling is stored, listed and returned by authenticate; none means none", () => {
    const made = new Map<string, Sensitivity | null>();
    for (const tier of SENSITIVITIES) {
      const { token, record } = cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: tier });
      expect(record.maxSensitivity).toBe(tier);
      expect(cp.authenticate(token)).toMatchObject({ ok: true, maxSensitivity: tier });
      made.set(record.id, tier);
    }
    const open = cp.createToken({ tenantId: "acme", room: "team" });
    expect(open.record.maxSensitivity).toBeNull();
    expect(cp.authenticate(open.token)).toMatchObject({ ok: true, maxSensitivity: null });
    made.set(open.record.id, null);
    // (listed order is by creation second, which several tokens made in one test share)
    const listed = new Map(cp.listTokens("acme").map((t) => [t.id, t.maxSensitivity]));
    expect(listed).toEqual(made);
  });

  test("an unknown tier is refused at creation, not silently stored as 'no ceiling'", () => {
    for (const bad of ["secret", "PUBLIC", "", "none"]) {
      let code: string | undefined;
      try {
        cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: bad as Sensitivity });
      } catch (err) {
        code = err instanceof TenantError ? err.code : "other";
      }
      expect(code, JSON.stringify(bad)).toBe("invalid_sensitivity");
    }
    expect(cp.listTokens("acme")).toEqual([]);
  });

  test("a hand-edited database value that is not a tier becomes the LOWEST ceiling, never no ceiling", () => {
    const { token, record } = cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: "internal" });
    closeAllDbs();
    const db = new Database(join(dir, "data", "control.db"));
    db.query("UPDATE tokens SET max_sensitivity = 'bogus' WHERE id = ?").run(record.id);
    db.close();
    cp = new ControlPlane(join(dir, "data"));
    expect(cp.authenticate(token)).toMatchObject({ ok: true, maxSensitivity: "public" });
  });
});

// ── end to end: a real MCP session under a ceiling ───────────────────────────

const READ_CAPS = ["read_skill", "list_skills", "search_skills", "activate_skill", "deactivate_skill"];
const BASE = "http://harbor.test";
type Json = Record<string, any>;

function serve(): ServerHandler {
  handler = createServerHandler({ dataDir: join(dir, "data"), controlPlane: cp, logger: () => {} });
  return handler;
}

async function rpc(token: string, body: unknown, session?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (session) headers["mcp-session-id"] = session;
  return (handler as ServerHandler).fetch(new Request(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }));
}
async function open(token: string): Promise<string> {
  const res = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(res.status).toBe(200);
  return res.headers.get("mcp-session-id") as string;
}
async function tool(token: string, sid: string, name: string, args: Json = {}): Promise<{ text: string; isError: boolean }> {
  const res = await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sid);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Json;
  return {
    text: (body.result.content as Array<{ text: string }>).map((c) => c.text).join("\n"),
    isError: Boolean(body.result.isError),
  };
}

/**
 * Room `team` holds four skills labeled by per-skill override (public / internal /
 * restricted) and one nobody labeled. Room `wiki` has a room default of public with
 * one restricted override. Room `oops` has a typo'd default.
 */
function seed(): void {
  tenantWith(
    {
      team: ["pub-guide", "int-handbook", "secret-plan", "unlabeled-notes"],
      wiki: ["wiki-page", "wiki-payroll"],
      oops: ["oops-skill"],
    },
    ["pub-guide", "int-handbook", "secret-plan", "unlabeled-notes", "wiki-page", "wiki-payroll", "oops-skill"],
  );
  const path = cp.tenantConfigPath("acme");
  const roomCaps = (r: string): string => `[skills.rooms.${r}]`;
  let toml = readFileSync(path, "utf8");
  for (const r of ["team", "wiki", "oops"]) toml = toml.replace(roomCaps(r), `${roomCaps(r)}\ncapabilities = ${JSON.stringify(READ_CAPS)}`);
  toml = toml.replace(roomCaps("wiki"), `${roomCaps("wiki")}\nsensitivity = "public"`);
  toml = toml.replace(roomCaps("oops"), `${roomCaps("oops")}\nsensitivity = "publik"`);
  toml += `\n[skills.skill_sensitivity]\npub-guide = "public"\nint-handbook = "internal"\nsecret-plan = "restricted"\nwiki-payroll = "restricted"\n`;
  writeFileSync(path, toml);
}

const names = (text: string): string[] => [...text.matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1] as string);
const ALL_TEAM = ["int-handbook", "pub-guide", "secret-plan", "unlabeled-notes"];

describe("a session under a ceiling", () => {
  beforeEach(() => {
    seed();
    serve();
  });

  test("no ceiling: every skill its room grants is listed and readable — as before labels existed", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "team" });
    const sid = await open(token);
    expect(names((await tool(token, sid, "list_skills")).text).sort()).toEqual(ALL_TEAM);
    for (const s of ALL_TEAM) {
      const r = await tool(token, sid, "read_skill", { skill_name: s });
      expect(r.isError, s).toBe(false);
      expect(r.text).toContain(`# ${s}`);
    }
  });

  test.each([
    ["public", ["pub-guide"]],
    ["internal", ["int-handbook", "pub-guide"]],
    ["restricted", ["int-handbook", "pub-guide", "secret-plan"]], // never the unlabeled one
  ] as Array<[Sensitivity, string[]]>)("ceiling %s: lists exactly %j", async (tier, visible) => {
    const { token } = cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: tier });
    const sid = await open(token);
    expect(names((await tool(token, sid, "list_skills")).text).sort()).toEqual(visible);

    const hidden = ALL_TEAM.filter((s) => !visible.includes(s));
    for (const s of ALL_TEAM) {
      for (const name of ["read_skill", "activate_skill"]) {
        const r = await tool(token, sid, name, { skill_name: s });
        if (visible.includes(s)) {
          expect(r.isError, `${name} ${s}`).toBe(false);
          expect(r.text).toContain(`# ${s}`);
        } else {
          expect(r.isError, `${name} ${s}`).toBe(true);
          expect(r.text).not.toContain(`# ${s}`); // no content
        }
      }
    }
    expect(hidden.length + visible.length).toBe(ALL_TEAM.length);
  });

  test("search and route never surface a skill above the ceiling, nor its name", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: "internal" });
    const sid = await open(token);

    const search = await tool(token, sid, "search_skills", { query: "secret plan notes unlabeled" });
    expect(search.text).not.toContain("secret-plan");
    expect(search.text).not.toContain("unlabeled-notes");
    const ok = await tool(token, sid, "search_skills", { query: "handbook" });
    expect(names(ok.text)).toEqual(["int-handbook"]);

    const route = await tool(token, sid, "route_skills", { prompt: "please run secret-plan and unlabeled-notes now" });
    expect(route.text).not.toContain("secret-plan");
    expect(route.text).not.toContain("unlabeled-notes");
    const routeOk = await tool(token, sid, "route_skills", { prompt: "please run int-handbook" });
    expect(routeOk.text).toContain("int-handbook");

    // the uncapped token, same prompts, does see them: the filtering is the ceiling's doing
    const open2 = cp.createToken({ tenantId: "acme", room: "team" });
    const sid2 = await open(open2.token);
    expect(names((await tool(open2.token, sid2, "search_skills", { query: "secret plan" })).text)).toContain("secret-plan");
    expect((await tool(open2.token, sid2, "route_skills", { prompt: "please run secret-plan" })).text).toContain("secret-plan");
  });

  test("the agent cannot tell 'above my ceiling' from 'not in my room'; the audit row can", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: "public", principal: "kim" });
    const sid = await open(token);
    const tooHigh = await tool(token, sid, "read_skill", { skill_name: "secret-plan" });
    const elsewhere = await tool(token, sid, "read_skill", { skill_name: "wiki-page" }); // real skill, other room
    const nowhere = await tool(token, sid, "read_skill", { skill_name: "no-such-skill" });
    const shape = (t: string): string => t.replace(/'[a-z-]+'/, "'X'");
    expect(shape(tooHigh.text)).toBe(shape(elsewhere.text));
    expect(shape(tooHigh.text)).toBe(shape(nowhere.text));
    expect(tooHigh.text).not.toMatch(/restricted|ceiling|public/i);

    const rows = auditRead(cp.tenantEnvironment("acme"), { limit: 200 }).filter((r) => r.sessionId === sid);
    const denial = rows.find((r) => r.decision === "denied" && r.resource === "secret-plan");
    expect(denial?.reason).toBe("skill 'secret-plan' is restricted; this token's ceiling is public");
    expect(denial?.agentId).toBe("kim"); // attributed to the person
    expect(rows.some((r) => r.decision === "allowed" && r.reason.includes("ceiling=public"))).toBe(true); // session_open records it
  });

  test("an unlabeled skill is refused to a capped token and the audit says why", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: "restricted" });
    const sid = await open(token);
    expect((await tool(token, sid, "read_skill", { skill_name: "unlabeled-notes" })).isError).toBe(true);
    const rows = auditRead(cp.tenantEnvironment("acme"), { limit: 200 }).filter((r) => r.sessionId === sid);
    expect(rows.find((r) => r.resource === "unlabeled-notes")?.reason).toBe(
      "skill 'unlabeled-notes' is unlabeled; this token's ceiling is restricted",
    );
  });

  test("a room default applies to its skills; a per-skill override beats it", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "wiki", maxSensitivity: "public" });
    const sid = await open(token);
    expect(names((await tool(token, sid, "list_skills")).text)).toEqual(["wiki-page"]); // room default: public
    expect((await tool(token, sid, "read_skill", { skill_name: "wiki-page" })).isError).toBe(false);
    expect((await tool(token, sid, "read_skill", { skill_name: "wiki-payroll" })).isError).toBe(true); // override: restricted
  });

  test("a mistyped room label fails closed: it is restricted, never open", async () => {
    const internal = cp.createToken({ tenantId: "acme", room: "oops", maxSensitivity: "internal" });
    const sid = await open(internal.token);
    expect((await tool(internal.token, sid, "read_skill", { skill_name: "oops-skill" })).isError).toBe(true);
    expect(names((await tool(internal.token, sid, "list_skills")).text)).toEqual([]);
    const restricted = cp.createToken({ tenantId: "acme", room: "oops", maxSensitivity: "restricted" });
    const sid2 = await open(restricted.token);
    expect((await tool(restricted.token, sid2, "read_skill", { skill_name: "oops-skill" })).isError).toBe(false);
  });

  test("a refused read is not charged to the person's daily quota", async () => {
    const { token } = cp.createToken({
      tenantId: "acme",
      room: "team",
      maxSensitivity: "public",
      principal: "kim",
      dailyReadQuota: 1,
    });
    const sid = await open(token);
    for (let i = 0; i < 3; i++) expect((await tool(token, sid, "read_skill", { skill_name: "secret-plan" })).isError).toBe(true);
    const ok = await tool(token, sid, "read_skill", { skill_name: "pub-guide" });
    expect(ok.isError).toBe(false); // the one allowed load is still there
    expect((await tool(token, sid, "read_skill", { skill_name: "pub-guide" })).isError).toBe(true); // now spent
  });

  test("relabeling takes effect on the very next request of an open session, in both directions", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: "public" });
    const sid = await open(token);
    const path = cp.tenantConfigPath("acme");
    const relabel = (skill: string, tier: Sensitivity): void => {
      setSkillLabel(cp.tenantEnvironment("acme"), skill, tier);
      const future = new Date(Date.now() + 5000 * ++bump); // the environment cache keys on mtime
      utimesSync(path, future, future);
    };
    let bump = 0;
    expect((await tool(token, sid, "read_skill", { skill_name: "secret-plan" })).isError).toBe(true);
    relabel("secret-plan", "public");
    expect((await tool(token, sid, "read_skill", { skill_name: "secret-plan" })).isError).toBe(false);
    relabel("secret-plan", "restricted");
    expect((await tool(token, sid, "read_skill", { skill_name: "secret-plan" })).isError).toBe(true);
  });

  test("the ceiling belongs to the token: one person's capped and uncapped tokens do not share it", async () => {
    const capped = cp.createToken({ tenantId: "acme", room: "team", maxSensitivity: "public", principal: "kim" });
    const house = cp.createToken({ tenantId: "acme", room: "team", principal: "kim" });
    const a = await open(capped.token);
    const b = await open(house.token);
    expect((await tool(capped.token, a, "read_skill", { skill_name: "secret-plan" })).isError).toBe(true);
    expect((await tool(house.token, b, "read_skill", { skill_name: "secret-plan" })).isError).toBe(false);
    // and a session id from one cannot be used with the other
    const res = await rpc(house.token, { jsonrpc: "2.0", id: 3, method: "tools/list" }, a);
    expect(res.status).toBe(404);
  });
});

// ── the CLI ──────────────────────────────────────────────────────────────────

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = [];
  const sink = (...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
  const origLog = console.log;
  const origErr = console.error;
  const savedExit = process.exitCode;
  console.log = sink as typeof console.log;
  console.error = sink as typeof console.error;
  process.exitCode = 0;
  let threw = false;
  try {
    await runCommand(main, { rawArgs: args });
  } catch (err) {
    threw = true;
    sink(err instanceof Error ? err.message : String(err));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const code = threw ? 1 : typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = savedExit ?? 0; // (assigning undefined does NOT reset it in Bun)
  return { code, out: logs.join("\n") };
}

describe("harbor label / token create --max-sensitivity", () => {
  test("label set, list and clear through the command tree", async () => {
    tenantWith({ legal: ["nda", "memo"] }, ["nda", "memo"]);
    const cfg = ["--config", cp.tenantConfigPath("acme")];

    let r = await cli("label", "set", "--room", "legal", "--tier", "internal", ...cfg);
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("labeled internal");
    r = await cli("label", "set", "--skill", "memo", "--tier", "restricted", ...cfg);
    expect(r.code).toBe(0);

    r = await cli("label", "list", ...cfg);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/legal\s+nda\s+internal \(room\)/);
    expect(r.out).toMatch(/legal\s+memo\s+restricted \(skill\)/);
    expect(r.out).not.toContain("UNLABELED");

    r = await cli("label", "clear", "--skill", "memo", ...cfg);
    expect(r.code).toBe(0);
    r = await cli("label", "clear", "--skill", "memo", ...cfg);
    expect(r.out).toContain("already unlabeled");
  });

  test("list warns about unlabeled skills, and bad input exits non-zero without touching the file", async () => {
    tenantWith({ legal: ["nda"] }, ["nda"]);
    const cfg = ["--config", cp.tenantConfigPath("acme")];
    const before = readFileSync(cp.tenantConfigPath("acme"), "utf8");
    const list = await cli("label", "list", ...cfg);
    expect(list.out).toContain("UNLABELED");
    expect(list.out).toContain("refused them");

    for (const bad of [
      ["label", "set", "--room", "legal", "--tier", "secret"],
      ["label", "set", "--room", "ghost", "--tier", "public"],
      ["label", "set", "--skill", "ghost", "--tier", "public"],
      ["label", "set", "--tier", "public"], // neither
      ["label", "set", "--room", "legal", "--skill", "nda", "--tier", "public"], // both
    ]) {
      const r = await cli(...bad, ...cfg);
      expect(r.code, bad.join(" ")).toBe(1);
    }
    expect(readFileSync(cp.tenantConfigPath("acme"), "utf8")).toBe(before);
  });

  test("token create --max-sensitivity stores the ceiling, says so, and rejects an unknown tier", async () => {
    tenantWith({ team: ["s"] }, ["s"]);
    const D = ["--data-dir", join(dir, "data")];
    const ok = await cli("token", "create", "--tenant", "acme", "--room", "team", "--max-sensitivity", "internal", ...D);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("ceiling internal");
    expect(cp.listTokens("acme")[0]?.maxSensitivity).toBe("internal");

    const none = await cli("token", "create", "--tenant", "acme", "--room", "team", ...D);
    expect(none.out).toContain("ceiling none");

    const bad = await cli("token", "create", "--tenant", "acme", "--room", "team", "--max-sensitivity", "secret", ...D);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("maxSensitivity must be one of");
    expect(cp.listTokens("acme")).toHaveLength(2); // nothing minted for the bad one

    const list = await cli("token", "list", ...D);
    expect(list.out).toContain("[ceiling: internal]");
  });
});
