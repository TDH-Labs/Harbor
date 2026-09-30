/**
 * delegation.test.ts — a house agent acting FOR a person.
 *
 * The property under test: a delegate token can never do more than the grant of
 * the person it names, can be pointed at nobody the operator has not granted,
 * and follows that grant as it changes — while a token that is not a delegate
 * cannot claim to act for anyone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "citty";

import { main } from "./cli.ts";
import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";
import { createServerHandler, ON_BEHALF_OF_HEADER, type ServerHandler, type ServerOptions } from "./http-server.ts";
import { auditRead } from "./isolation.ts";
import { ControlPlane, TenantError } from "./tenants.ts";

let dir: string;
let cp: ControlPlane;
let handler: ServerHandler | undefined;
let clock: number;
const savedRouter = process.env.HARBOR_SYSTEM_ONE_URL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-deleg-"));
  cp = new ControlPlane(join(dir, "data"));
  clock = Date.now();
  process.env.HARBOR_SYSTEM_ONE_URL = "http://127.0.0.1:59992";
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

const READ_CAPS = ["read_skill", "list_skills", "search_skills", "activate_skill", "deactivate_skill"];

/**
 * Room `legal`: an internal skill, a restricted one and an unlabeled one.
 * Room `finance`: one restricted skill. (Labels are per-skill overrides.)
 */
function seed(): void {
  cp.createTenant("acme");
  const root = cp.tenantRoot("acme");
  const rooms: Record<string, string[]> = {
    legal: ["nda-review", "payroll-run", "loose-notes"],
    finance: ["ledger-close"],
  };
  const toml =
    `[paths]\nhome = ${JSON.stringify(root)}\n\n` +
    Object.entries(rooms)
      .map(([r, s]) => `[skills.rooms.${r}]\nskills = ${JSON.stringify(s)}\ncapabilities = ${JSON.stringify(READ_CAPS)}\n`)
      .join("\n") +
    `\n[skills.skill_sensitivity]\nnda-review = "internal"\npayroll-run = "restricted"\nledger-close = "restricted"\n`;
  writeFileSync(join(root, ".agent-env", "config.toml"), toml);
  for (const name of Object.values(rooms).flat()) {
    const d = join(root, ".agents", "skills", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: About ${name}\n---\n\n# ${name}\n`);
  }
}

function serve(extra: Partial<ServerOptions> = {}): ServerHandler {
  handler = createServerHandler({
    dataDir: join(dir, "data"),
    controlPlane: cp,
    now: () => clock,
    logger: () => {},
    ...extra,
  });
  return handler;
}

const BASE = "http://harbor.test";
type Json = Record<string, any>;

async function rpc(
  token: string,
  body: unknown,
  opts: { session?: string; onBehalf?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (opts.session) headers["mcp-session-id"] = opts.session;
  if (opts.onBehalf) headers[ON_BEHALF_OF_HEADER] = opts.onBehalf;
  return (handler as ServerHandler).fetch(new Request(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }));
}
async function open(token: string, onBehalf?: string): Promise<string> {
  const res = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { onBehalf: onBehalf ?? null });
  expect(res.status).toBe(200);
  return res.headers.get("mcp-session-id") as string;
}
async function tool(
  token: string,
  sid: string,
  name: string,
  args: Json = {},
  onBehalf?: string,
): Promise<{ text: string; isError: boolean; status: number }> {
  const res = await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, { session: sid, onBehalf: onBehalf ?? null });
  if (res.status !== 200) return { text: await res.text(), isError: true, status: res.status };
  const body = (await res.json()) as Json;
  return {
    text: (body.result.content as Array<{ text: string }>).map((c) => c.text).join("\n"),
    isError: Boolean(body.result.isError),
    status: 200,
  };
}
const names = (text: string): string[] => [...text.matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1] as string);

// ── the control plane ────────────────────────────────────────────────────────

describe("delegate tokens and grants (control plane)", () => {
  beforeEach(seed);

  test("a delegate token has no room, person, ceiling or quota of its own", () => {
    const { token, record } = cp.createToken({ tenantId: "acme", delegate: true });
    expect(record).toMatchObject({ delegate: true, room: "", principal: "", maxSensitivity: null, dailyTokenQuota: null, dailyReadQuota: null });
    expect(cp.authenticate(token)).toMatchObject({ ok: true, delegate: true, room: "", principal: "", maxSensitivity: null });
    const normal = cp.createToken({ tenantId: "acme", room: "legal" });
    expect(normal.record.delegate).toBe(false);
    expect(cp.authenticate(normal.token)).toMatchObject({ ok: true, delegate: false });
  });

  test.each([
    ["a room", { room: "legal" }],
    ["a person", { principal: "kim" }],
    ["a sensitivity ceiling", { maxSensitivity: "internal" as const }],
    ["quotas", { dailyTokenQuota: 10 }],
    ["quotas", { dailyReadQuota: 10 }],
    ["admin", { allowAdmin: true, capabilities: ["admin"] }],
    ["admin", { capabilities: ["admin"] }],
  ])("a delegate token cannot carry %s", (_what, extra) => {
    let code: string | undefined;
    try {
      cp.createToken({ tenantId: "acme", delegate: true, ...extra });
    } catch (err) {
      code = err instanceof TenantError ? err.code : "other";
    }
    expect(code).toBe("invalid_delegate");
    expect(cp.listTokens("acme")).toEqual([]);
  });

  test("a delegate MAY be capped in what it can do at all (a capability ceiling); a normal token still needs a room", () => {
    const { record } = cp.createToken({ tenantId: "acme", delegate: true, capabilities: ["read_skill", "list_skills"] });
    expect(record.capabilities).toEqual(["read_skill", "list_skills"]);
    expect(() => cp.createToken({ tenantId: "acme" })).toThrow(/invalid room name/);
    expect(() => cp.createToken({ tenantId: "acme", room: "" })).toThrow(/invalid room name/);
  });

  test("setGrant validates, creates the person, and replaces (one grant per person)", () => {
    const g = cp.setGrant("acme", "kim@example.com", { room: "legal", clearance: "internal", dailyReadQuota: 5 });
    expect(g).toMatchObject({ tenantId: "acme", principal: "kim@example.com", room: "legal", clearance: "internal", dailyReadQuota: 5, dailyTokenQuota: null });
    expect(cp.listPrincipals("acme").map((p) => p.id)).toEqual(["kim@example.com"]); // suspend/offboard can find them

    const replaced = cp.setGrant("acme", "kim@example.com", { room: "finance", clearance: "restricted" });
    expect(replaced).toMatchObject({ room: "finance", clearance: "restricted", dailyReadQuota: null });
    expect(cp.listGrants("acme")).toHaveLength(1);

    const bad: Array<[string, () => unknown, string]> = [
      ["tier", () => cp.setGrant("acme", "kim", { room: "legal", clearance: "secret" as never }), "invalid_sensitivity"],
      ["no tier", () => cp.setGrant("acme", "kim", { room: "legal" } as never), "invalid_sensitivity"],
      ["room", () => cp.setGrant("acme", "kim", { room: "ghost", clearance: "public" }), "unknown_room"],
      ["room name", () => cp.setGrant("acme", "kim", { room: "../legal", clearance: "public" }), "invalid_room"],
      ["person", () => cp.setGrant("acme", "k m", { room: "legal", clearance: "public" }), "invalid_principal"],
      ["quota", () => cp.setGrant("acme", "kim", { room: "legal", clearance: "public", dailyTokenQuota: 0 }), "invalid_quota"],
      ["tenant", () => cp.setGrant("nope", "kim", { room: "legal", clearance: "public" }), "no_such_tenant"],
    ];
    for (const [what, fn, code] of bad) {
      let got: string | undefined;
      try {
        fn();
      } catch (err) {
        got = err instanceof TenantError ? err.code : "other";
      }
      expect(got, what).toBe(code);
    }
    expect(cp.listGrants("acme")).toHaveLength(1); // none of the refusals changed anything
  });

  test("resolveDelegation: each way to be refused, and what a grant yields", () => {
    expect(cp.resolveDelegation("acme", "bad name")).toEqual({ ok: false, reason: "invalid_person" });
    expect(cp.resolveDelegation("acme", "kim")).toEqual({ ok: false, reason: "unknown_person" });
    cp.createToken({ tenantId: "acme", room: "legal", principal: "kim" }); // a person on record, no grant
    expect(cp.resolveDelegation("acme", "kim")).toEqual({ ok: false, reason: "no_grant" });
    cp.setGrant("acme", "kim", { room: "legal", clearance: "internal", dailyTokenQuota: 100 });
    expect(cp.resolveDelegation("acme", "kim")).toEqual({
      ok: true,
      principal: "kim",
      room: "legal",
      clearance: "internal",
      dailyTokenQuota: 100,
      dailyReadQuota: null,
    });
    cp.setPrincipalStatus("acme", "kim", "suspended");
    expect(cp.resolveDelegation("acme", "kim")).toEqual({ ok: false, reason: "person_suspended" });
    cp.setPrincipalStatus("acme", "kim", "active");
    expect(cp.resolveDelegation("acme", "kim").ok).toBe(true);
    // a grant in one tenant is nothing in another
    cp.createTenant("globex");
    expect(cp.resolveDelegation("globex", "kim")).toEqual({ ok: false, reason: "unknown_person" });
  });

  test("offboarding removes the grant with the tokens; a hand-edited clearance becomes the lowest", () => {
    cp.setGrant("acme", "kim", { room: "legal", clearance: "restricted" });
    expect(cp.revokePrincipalTokens("acme", "kim")).toBe(0);
    expect(cp.listGrants("acme")).toEqual([]);
    expect(cp.resolveDelegation("acme", "kim")).toEqual({ ok: false, reason: "no_grant" });

    cp.setGrant("acme", "lee", { room: "legal", clearance: "internal" });
    closeAllDbs();
    const db = new Database(join(dir, "data", "control.db"));
    db.query("UPDATE grants SET clearance = 'bogus' WHERE principal = 'lee'").run();
    db.close();
    cp = new ControlPlane(join(dir, "data"));
    expect(cp.resolveDelegation("acme", "lee")).toMatchObject({ ok: true, clearance: "public" });
  });

  test("removeGrant reports whether there was one", () => {
    cp.setGrant("acme", "kim", { room: "legal", clearance: "public" });
    expect(cp.removeGrant("acme", "kim")).toBe(true);
    expect(cp.removeGrant("acme", "kim")).toBe(false);
  });
});

// ── over HTTP ────────────────────────────────────────────────────────────────

describe("a delegate token over HTTP", () => {
  let delegate: string;
  beforeEach(() => {
    seed();
    serve();
    delegate = cp.createToken({ tenantId: "acme", delegate: true, label: "son-of-anton" }).token;
    cp.setGrant("acme", "kim", { room: "legal", clearance: "internal" });
    cp.setGrant("acme", "lee", { room: "finance", clearance: "restricted" });
  });

  test("it must name a valid person on every request", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    expect((await rpc(delegate, init)).status).toBe(400); // no header
    expect(await (await rpc(delegate, init)).json()).toEqual({ error: "missing_on_behalf_of" });
    for (const bad of ["kim lee", "kim,lee", "../kim", "a".repeat(200)]) {
      const r = await rpc(delegate, init, { onBehalf: bad });
      expect(r.status, bad).toBe(400);
    }
    const sid = await open(delegate, "kim");
    const res = await rpc(delegate, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { session: sid }); // header dropped
    expect(res.status).toBe(400);
  });

  test("it can act for nobody the operator has not granted, and the client cannot tell why", async () => {
    cp.createToken({ tenantId: "acme", room: "legal", principal: "nogrant" }); // on record, no grant
    cp.createToken({ tenantId: "acme", room: "legal", principal: "paused" });
    cp.setGrant("acme", "paused", { room: "legal", clearance: "public" });
    cp.setPrincipalStatus("acme", "paused", "suspended");
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const bodies: string[] = [];
    for (const who of ["stranger", "nogrant", "paused"]) {
      const r = await rpc(delegate, init, { onBehalf: who });
      expect(r.status, who).toBe(403);
      bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1); // identical: no probing which people exist
  });

  test("it serves each person exactly what their grant allows", async () => {
    const kim = await open(delegate, "kim");
    expect(names((await tool(delegate, kim, "list_skills", {}, "kim")).text)).toEqual(["nda-review"]); // internal ceiling; payroll restricted, loose unlabeled
    expect((await tool(delegate, kim, "read_skill", { skill_name: "nda-review" }, "kim")).isError).toBe(false);
    expect((await tool(delegate, kim, "read_skill", { skill_name: "payroll-run" }, "kim")).isError).toBe(true);
    expect((await tool(delegate, kim, "read_skill", { skill_name: "loose-notes" }, "kim")).isError).toBe(true);
    expect((await tool(delegate, kim, "read_skill", { skill_name: "ledger-close" }, "kim")).isError).toBe(true); // another room

    const lee = await open(delegate, "lee");
    expect(names((await tool(delegate, lee, "list_skills", {}, "lee")).text)).toEqual(["ledger-close"]);
    expect((await tool(delegate, lee, "read_skill", { skill_name: "ledger-close" }, "lee")).isError).toBe(false);
    expect((await tool(delegate, lee, "read_skill", { skill_name: "nda-review" }, "lee")).isError).toBe(true); // legal is not lee's room
  });

  test("a session belongs to the person it was opened for", async () => {
    const kim = await open(delegate, "kim");
    // the house agent (or an injected prompt) tries to reuse kim's session as lee, or with no name at all
    expect((await tool(delegate, kim, "read_skill", { skill_name: "ledger-close" }, "lee")).status).toBe(404);
    expect((await tool(delegate, kim, "list_skills", {}, "lee")).status).toBe(404);
    expect((await tool(delegate, kim, "list_skills", {}, "kim")).status).toBe(200); // still hers
    // and DELETE is bound the same way
    const res = await (handler as ServerHandler).fetch(
      new Request(`${BASE}/mcp`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${delegate}`, "mcp-session-id": kim, [ON_BEHALF_OF_HEADER]: "lee" },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("a token that is not a delegate cannot claim to act for anyone, not even itself", async () => {
    const own = cp.createToken({ tenantId: "acme", room: "legal", principal: "kim", maxSensitivity: "public" }).token;
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    for (const who of ["lee", "kim"]) expect((await rpc(own, init, { onBehalf: who })).status, who).toBe(403);
    expect((await rpc(own, init)).status).toBe(200); // without the header it is an ordinary token
  });

  test("it follows the grant as it changes: suspend, ungrant, offboard, and back", async () => {
    const kim = await open(delegate, "kim");
    const ok = () => tool(delegate, kim, "read_skill", { skill_name: "nda-review" }, "kim");
    expect((await ok()).status).toBe(200);

    cp.setPrincipalStatus("acme", "kim", "suspended");
    expect((await ok()).status).toBe(403);
    cp.setPrincipalStatus("acme", "kim", "active");
    expect((await ok()).status).toBe(200); // the same session carries on

    cp.removeGrant("acme", "kim");
    expect((await ok()).status).toBe(403);
    cp.setGrant("acme", "kim", { room: "legal", clearance: "internal" });
    expect((await ok()).status).toBe(200);

    cp.revokePrincipalTokens("acme", "kim"); // offboarding also ends what the house agent may do for them
    expect((await ok()).status).toBe(403);
    expect((await rpc(delegate, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { onBehalf: "kim" })).status).toBe(403);
    expect((await open(delegate, "lee").catch(() => "")) !== "").toBe(true); // everyone else is unaffected
  });

  test("a changed grant ends the open session, and the next one gets the new entitlements", async () => {
    const kim = await open(delegate, "kim");
    expect((await tool(delegate, kim, "read_skill", { skill_name: "nda-review" }, "kim")).status).toBe(200);

    cp.setGrant("acme", "kim", { room: "legal", clearance: "public" }); // lowered
    expect((await tool(delegate, kim, "read_skill", { skill_name: "nda-review" }, "kim")).status).toBe(404); // dropped: re-initialize
    const fresh = await open(delegate, "kim");
    expect((await tool(delegate, fresh, "read_skill", { skill_name: "nda-review" }, "kim")).isError).toBe(true); // internal > public
    expect(names((await tool(delegate, fresh, "list_skills", {}, "kim")).text)).toEqual([]);

    cp.setGrant("acme", "kim", { room: "finance", clearance: "restricted" }); // moved
    expect((await tool(delegate, fresh, "list_skills", {}, "kim")).status).toBe(404);
    const moved = await open(delegate, "kim");
    expect(names((await tool(delegate, moved, "list_skills", {}, "kim")).text)).toEqual(["ledger-close"]);
  });

  test("delivery counts against the PERSON's allowance, shared with their own tokens", async () => {
    cp.setGrant("acme", "kim", { room: "legal", clearance: "internal", dailyReadQuota: 2 });
    const own = cp.createToken({ tenantId: "acme", room: "legal", principal: "kim", maxSensitivity: "internal", dailyReadQuota: 2 }).token;
    const sid = await open(delegate, "kim");
    const load = () => tool(delegate, sid, "read_skill", { skill_name: "nda-review" }, "kim");
    expect((await load()).isError).toBe(false);
    expect((await load()).isError).toBe(false);
    const third = await load();
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/quota/i);
    // kim's own agent shares that bucket: the house agent already spent it
    const mine = await open(own);
    expect((await tool(own, mine, "read_skill", { skill_name: "nda-review" })).isError).toBe(true);
    // another person's allowance is untouched
    cp.setGrant("acme", "lee", { room: "finance", clearance: "restricted", dailyReadQuota: 2 });
    const lee = await open(delegate, "lee");
    expect((await tool(delegate, lee, "read_skill", { skill_name: "ledger-close" }, "lee")).isError).toBe(false);
  });

  test("the grant's quotas are read on every request: tightening and loosening apply to the open session", async () => {
    const sid = await open(delegate, "kim");
    const load = () => tool(delegate, sid, "read_skill", { skill_name: "nda-review" }, "kim");
    cp.setGrant("acme", "kim", { room: "legal", clearance: "internal", dailyTokenQuota: 1 }); // smaller than any skill
    const refused = await load();
    expect(refused.status).toBe(200);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/token quota/i);
    expect(refused.text).not.toContain("# nda-review");
    cp.setGrant("acme", "kim", { room: "legal", clearance: "internal", dailyTokenQuota: 100_000 });
    expect((await load()).isError).toBe(false); // same session: only the allowance changed
  });

  test("the audit trail names the person and records the delegate", async () => {
    const sid = await open(delegate, "kim");
    await tool(delegate, sid, "read_skill", { skill_name: "payroll-run" }, "kim");
    await tool(delegate, sid, "read_skill", { skill_name: "nda-review" }, "kim");
    const rows = auditRead(cp.tenantEnvironment("acme"), { limit: 200 }).filter((r) => r.sessionId === sid);
    expect(rows.length).toBeGreaterThan(2);
    expect(new Set(rows.map((r) => r.agentId))).toEqual(new Set(["kim"])); // never the token, never blank
    const opened = rows.find((r) => r.resource.startsWith("hbr_"));
    expect(opened?.reason).toMatch(/^principal=kim ceiling=internal via=delegate:hbr_[0-9a-f]{12}…?/);
    expect(rows.some((r) => r.decision === "denied" && r.resource === "payroll-run")).toBe(true);
  });

  test("busy people do not spend each other's request allowance, or session cap", async () => {
    handler?.close();
    serve({ rateLimitPerMinute: 3, maxSessionsPerToken: 1 });
    const one = await open(delegate, "kim"); // 1 request
    expect((await tool(delegate, one, "list_skills", {}, "kim")).status).toBe(200); // 2
    expect((await tool(delegate, one, "list_skills", {}, "kim")).status).toBe(200); // 3
    expect((await tool(delegate, one, "list_skills", {}, "kim")).status).toBe(429); // kim is out…
    expect((await rpc(delegate, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { onBehalf: "lee" })).status).toBe(200); // …lee is not
    // the session cap is per person too: a second session for kim is refused, lee already has hers
    clock += 61_000;
    expect((await rpc(delegate, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { onBehalf: "kim" })).status).toBe(429);
  });

  test("revoking or suspending the delegate token itself stops everything, for everyone", async () => {
    const kim = await open(delegate, "kim");
    const id = cp.listTokens("acme").find((t) => t.delegate)?.id as string;
    cp.revokeToken(id);
    expect((await tool(delegate, kim, "list_skills", {}, "kim")).status).toBe(401);
    expect((await rpc(delegate, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { onBehalf: "lee" })).status).toBe(401);
  });

  test("a capability ceiling on the delegate token caps every person it serves", async () => {
    const narrow = cp.createToken({ tenantId: "acme", delegate: true, capabilities: ["list_skills"] }).token;
    const sid = await open(narrow, "lee"); // lee is cleared for restricted, but the delegate may only list
    expect(names((await tool(narrow, sid, "list_skills", {}, "lee")).text)).toEqual(["ledger-close"]);
    const read = await tool(narrow, sid, "read_skill", { skill_name: "ledger-close" }, "lee");
    expect(read.isError).toBe(true);
    expect(read.text).not.toContain("# ledger-close");
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
  process.exitCode = savedExit;
  return { code, out: logs.join("\n") };
}

describe("harbor principal grant / token create --delegate", () => {
  beforeEach(seed);
  const D = (): string[] => ["--data-dir", join(dir, "data")];

  test("grant, list, replace, ungrant", async () => {
    let r = await cli("principal", "grant", "kim", "--tenant", "acme", "--room", "legal", "--clearance", "internal", "--daily-read-quota", "9", ...D());
    expect(r.code).toBe(0);
    expect(r.out).toContain("up to internal");
    r = await cli("principal", "grants", "--tenant", "acme", ...D());
    expect(r.out).toMatch(/kim\s+legal\s+up to internal\s+\[quota\/day: ∞ tok, 9 loads\]/);
    r = await cli("principal", "grant", "kim", "--tenant", "acme", "--room", "finance", "--clearance", "public", ...D());
    expect(cp.listGrants("acme")[0]).toMatchObject({ room: "finance", clearance: "public", dailyReadQuota: null });
    r = await cli("principal", "ungrant", "kim", "--tenant", "acme", ...D());
    expect(r.out).toContain("removed");
    r = await cli("principal", "ungrant", "kim", "--tenant", "acme", ...D());
    expect(r.out).toContain("had no grant");
    r = await cli("principal", "grants", ...D());
    expect(r.out).toContain("no grants");
  });

  test("grant refuses what would be a silent hole: no clearance, a bad tier, an unknown room", async () => {
    for (const bad of [
      ["principal", "grant", "kim", "--tenant", "acme", "--room", "legal"], // no clearance: there is no implicit 'everything'
      ["principal", "grant", "kim", "--tenant", "acme", "--room", "legal", "--clearance", "secret"],
      ["principal", "grant", "kim", "--tenant", "acme", "--room", "ghost", "--clearance", "public"],
      ["principal", "grant", "kim", "--tenant", "acme", "--clearance", "public"],
      ["principal", "grant", "kim", "--room", "legal", "--clearance", "public"],
    ]) {
      expect((await cli(...bad, ...D())).code, bad.join(" ")).toBe(1);
    }
    expect(cp.listGrants("acme")).toEqual([]);
  });

  test("token create --delegate needs no room, says what it is, and rejects what it cannot carry", async () => {
    const ok = await cli("token", "create", "--tenant", "acme", "--delegate", ...D());
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("DELEGATE");
    expect(cp.listTokens("acme")[0]).toMatchObject({ delegate: true, room: "" });
    expect((await cli("token", "list", ...D())).out).toContain("[delegate]");

    for (const extra of [["--room", "legal"], ["--principal", "kim"], ["--max-sensitivity", "public"], ["--daily-read-quota", "3"], ["--allow-admin", "--capabilities", "admin"]]) {
      const r = await cli("token", "create", "--tenant", "acme", "--delegate", ...extra, ...D());
      expect(r.code, extra.join(" ")).toBe(1);
      expect(r.out).toContain("cannot carry");
    }
    expect(cp.listTokens("acme")).toHaveLength(1);
    expect((await cli("token", "create", "--tenant", "acme", ...D())).code).toBe(1); // still needs --room without --delegate
  });

  test("principal revoke removes the grant too", async () => {
    cp.setGrant("acme", "kim", { room: "legal", clearance: "public" });
    expect((await cli("principal", "revoke", "kim", "--tenant", "acme", ...D())).code).toBe(0);
    expect(cp.listGrants("acme")).toEqual([]);
  });
});
