/**
 * audit-exposure.test.ts — what an agent can read back about OTHER people.
 *
 * `audit_recent` and `list_rooms` are open to every session. On a Harbor Server the
 * room-wide audit log names other people, the skills they loaded, and (with
 * sensitivity labels) which skill names sit above a ceiling; the tenant's room list
 * says who works on what. A bring-your-own agent must not be able to read those back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMcpServer } from "../integrations/mcp-server.ts";
import { audit } from "./audit.ts";
import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";
import { createServerHandler, ON_BEHALF_OF_HEADER, type ServerHandler } from "./http-server.ts";
import { AgentSession, auditRead } from "./isolation.ts";
import { agentFacingReason, denialReason } from "./sensitivity.ts";
import { ControlPlane } from "./tenants.ts";

const READ_CAPS = ["read_skill", "list_skills", "search_skills", "activate_skill", "deactivate_skill"];
const BASE = "http://harbor.test";

let dir: string;
let cp: ControlPlane;
let handler: ServerHandler;
const savedRouter = process.env.HARBOR_SYSTEM_ONE_URL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-auditexp-"));
  process.env.HARBOR_SYSTEM_ONE_URL = "http://127.0.0.1:59992";
  cp = new ControlPlane(join(dir, "data"));
  cp.createTenant("acme");
  const root = cp.tenantRoot("acme");
  const rooms: Record<string, string[]> = { team: ["pub-guide", "secret-plan", "payroll-run"], layoffs: ["plan-b"] };
  writeFileSync(
    join(root, ".agent-env", "config.toml"),
    `[paths]\nhome = ${JSON.stringify(root)}\n\n` +
      Object.entries(rooms)
        .map(([r, s]) => `[skills.rooms.${r}]\ndescription = "the ${r} room"\nskills = ${JSON.stringify(s)}\ncapabilities = ${JSON.stringify(READ_CAPS)}\n`)
        .join("\n") +
      `\n[skills.skill_sensitivity]\npub-guide = "public"\nsecret-plan = "restricted"\npayroll-run = "restricted"\nplan-b = "restricted"\n`,
  );
  for (const name of Object.values(rooms).flat()) {
    const d = join(root, ".agents", "skills", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: About ${name}\n---\n\n# ${name}\n`);
  }
  handler = createServerHandler({ dataDir: join(dir, "data"), controlPlane: cp, logger: () => {} });
});
afterEach(() => {
  handler.close();
  closeAllDbs();
  Environment.unlockDefault();
  if (savedRouter === undefined) delete process.env.HARBOR_SYSTEM_ONE_URL;
  else process.env.HARBOR_SYSTEM_ONE_URL = savedRouter;
  rmSync(dir, { recursive: true, force: true });
});

async function rpc(token: string, body: unknown, opts: { session?: string; onBehalf?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (opts.session) headers["mcp-session-id"] = opts.session;
  if (opts.onBehalf) headers[ON_BEHALF_OF_HEADER] = opts.onBehalf;
  return handler.fetch(new Request(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }));
}
class Client {
  sid = "";
  constructor(readonly token: string, readonly onBehalf?: string) {}
  async open(): Promise<this> {
    const res = await rpc(this.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, this.onBehalf ? { onBehalf: this.onBehalf } : {});
    expect(res.status).toBe(200);
    this.sid = res.headers.get("mcp-session-id") as string;
    return this;
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await rpc(
      this.token,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      { session: this.sid, ...(this.onBehalf ? { onBehalf: this.onBehalf } : {}) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    return body.result.content.map((c) => c.text).join("\n");
  }
}

describe("what a session can read back about others", () => {
  test("a capped token sees only its own audit rows — not other people, not the names above its ceiling", async () => {
    const house = await new Client(cp.createToken({ tenantId: "acme", room: "team", principal: "owner@example.com" }).token).open();
    const byo = await new Client(cp.createToken({ tenantId: "acme", room: "team", principal: "byo@example.com", maxSensitivity: "public" }).token).open();
    // the house agent's user loads restricted skills the BYO agent has never heard of
    await house.call("read_skill", { skill_name: "payroll-run" });
    await house.call("read_skill", { skill_name: "secret-plan" });
    // the BYO agent guesses one name and is refused
    expect(await byo.call("read_skill", { skill_name: "secret-plan" })).toContain("not in room");

    const seen = await byo.call("audit_recent", { limit: 100 });
    expect(seen).not.toContain("payroll-run"); // a name it never tried
    expect(seen).not.toContain("owner@example.com");
    expect(seen).not.toMatch(/loaded \d+ tokens/); // the house agent's read rows
    // its OWN refusal is there, in the words it was given at the time — not the label
    const own = seen.split("\n").find((l) => l.startsWith("denied"));
    expect(own).toBe("denied  read_skill secret-plan — skill 'secret-plan' not in room 'team'");
    expect(own).not.toMatch(/restricted|unlabeled|ceiling|internal/i);
  });

  test("delegate sessions for different people cannot read each other's rows", async () => {
    const delegate = cp.createToken({ tenantId: "acme", delegate: true }).token;
    cp.setGrant("acme", "kim@example.com", { room: "team", clearance: "restricted" });
    cp.setGrant("acme", "lee@example.com", { room: "team", clearance: "public" });
    const kim = await new Client(delegate, "kim@example.com").open();
    const lee = await new Client(delegate, "lee@example.com").open();
    await kim.call("read_skill", { skill_name: "payroll-run" });
    const seenByLee = await lee.call("audit_recent", { limit: 100 });
    expect(seenByLee).not.toContain("payroll-run");
    expect(seenByLee).not.toContain("kim@example.com");
    expect(seenByLee).toContain("principal=lee@example.com"); // lee's own session_open is lee's to see
    const seenByKim = await kim.call("audit_recent", { limit: 100 });
    expect(seenByKim).toContain("payroll-run"); // your own history is yours
  });

  test("limit is bounded: negative and enormous values cannot dump the log", async () => {
    handler.close();
    handler = createServerHandler({ dataDir: join(dir, "data"), controlPlane: cp, logger: () => {}, rateLimitPerMinute: 100_000 });
    const c = await new Client(cp.createToken({ tenantId: "acme", room: "team", principal: "p@example.com" }).token).open();
    for (let i = 0; i < 130; i++) await c.call("read_skill", { skill_name: "pub-guide" });
    const lines = (t: string): number => t.split("\n").filter(Boolean).length;
    expect(lines(await c.call("audit_recent", { limit: -1 }))).toBe(1); // SQLite reads LIMIT -1 as "all rows"
    expect(lines(await c.call("audit_recent", { limit: 0 }))).toBe(1);
    expect(lines(await c.call("audit_recent", { limit: 1e9 }))).toBe(100);
    expect(lines(await c.call("audit_recent", { limit: 3 }))).toBe(3);
    expect(lines(await c.call("audit_recent", { limit: Number.NaN as unknown as number }))).toBeGreaterThan(0);
  });

  test("a server session lists only its own room; the tenant's other rooms are not disclosed", async () => {
    const c = await new Client(cp.createToken({ tenantId: "acme", room: "team" }).token).open();
    const rooms = await c.call("list_rooms");
    expect(rooms).toContain("team");
    expect(rooms).not.toContain("layoffs");
    expect(rooms).not.toContain("the layoffs room");
  });
});

describe("Harbor Core is unchanged", () => {
  test("a session with no identity still sees the room-wide log and every room", async () => {
    const stateDir = join(dir, ".agent-env");
    const cfgEnv = Environment.load(cp.tenantConfigPath("acme")); // rooms: team, layoffs
    void stateDir;
    audit.deny("s-other", "read_skill", "elsewhere", "someone else's refusal", { room: "team", agentId: "someone-else", env: cfgEnv });
    const server = createMcpServer({
      env: cfgEnv,
      resolveContext: () => ({ env: cfgEnv, session: new AgentSession({ room: "team", capabilities: READ_CAPS, sessionId: "core-1" }) }),
    });
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return ((r as { result: { content: Array<{ text: string }> } }).result.content).map((c) => c.text).join("\n");
    };
    expect(await call("audit_recent", { limit: 10 })).toContain("someone else's refusal");
    const rooms = await call("list_rooms");
    expect(rooms).toContain("team");
    expect(rooms).toContain("layoffs");
  });
});

describe("auditRead", () => {
  test("a negative limit is not 'no limit'; agent and room filters combine", () => {
    const env = Environment.load(cp.tenantConfigPath("acme"));
    for (let i = 0; i < 5; i++) audit.deny(`s${i}`, "read_skill", `r${i}`, "x", { room: i < 3 ? "team" : "layoffs", agentId: i % 2 ? "a" : "b", env });
    expect(auditRead(env, { limit: -1 })).toEqual([]);
    expect(auditRead(env, { limit: 2.9 })).toHaveLength(2);
    expect(auditRead(env, { agentId: "a" }).map((r) => r.resource).sort()).toEqual(["r1", "r3"]);
    expect(auditRead(env, { agentId: "a", room: "team" }).map((r) => r.resource)).toEqual(["r1"]);
    expect(auditRead(env, { agentId: "nobody" })).toEqual([]);
  });
});

describe("audit wording", () => {
  test("a sensitivity denial is shown to an agent as an out-of-room refusal; anything else is untouched", () => {
    for (const label of ["public", "internal", "restricted", null] as const) {
      const reason = denialReason("x-skill", label, "public");
      expect(agentFacingReason(reason, "team")).toBe("skill 'x-skill' not in room 'team'");
    }
    for (const other of ["skill 'x' not in room 'team'", "daily token quota exceeded (5/5 delivered today; resets 00:00 UTC)", "loaded 20 tokens", ""]) {
      expect(agentFacingReason(other, "team")).toBe(other);
    }
    // a skill name containing quotes and a decoy suffix cannot be used to smuggle text through
    const tricky = denialReason("a' is public; this token's ceiling is public", "restricted", "internal");
    expect(agentFacingReason(tricky, "team")).not.toContain("restricted");
  });
});
