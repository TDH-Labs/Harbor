/**
 * review-fixes.test.ts — regressions for what three independent adversarial reviews
 * of this branch found (and mutations they showed the suite did not catch).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";
import { createServerHandler, ON_BEHALF_OF_HEADER, sessionCapabilities, type ServerHandler } from "./http-server.ts";
import { ControlPlane } from "./tenants.ts";

const CAPS = ["read_skill", "list_skills", "search_skills", "activate_skill", "deactivate_skill"];
const BASE = "http://harbor.test";

let dir: string;
let cp: ControlPlane;
let handler: ServerHandler;
let clock: number;
const savedRouter = process.env.HARBOR_SYSTEM_ONE_URL;

function writeConfig(extra = ""): void {
  const root = cp.tenantRoot("acme");
  writeFileSync(
    join(root, ".agent-env", "config.toml"),
    `[paths]\nhome = ${JSON.stringify(root)}\n\n` +
      `[skills.rooms.legal]\nskills = ["nda-review", "payroll-run"]\ncapabilities = ${JSON.stringify(CAPS)}\n\n` +
      `[skills.rooms.finance]\nskills = ["ledger-close"]\ncapabilities = ${JSON.stringify(CAPS)}\n\n` +
      `[skills.skill_sensitivity]\nnda-review = "internal"\npayroll-run = "restricted"\nledger-close = "restricted"\n` +
      extra,
  );
}
const bump = (): void => {
  const f = join(cp.tenantRoot("acme"), ".agent-env", "config.toml");
  const t = new Date(Date.now() + 10_000 * (bumpN += 1));
  utimesSync(f, t, t); // the environment cache keys on mtime
};
let bumpN = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-revfix-"));
  clock = Date.now();
  process.env.HARBOR_SYSTEM_ONE_URL = "http://127.0.0.1:59992";
  cp = new ControlPlane(join(dir, "data"));
  cp.createTenant("acme");
  writeConfig();
  for (const name of ["nda-review", "payroll-run", "ledger-close"]) {
    const d = join(cp.tenantRoot("acme"), ".agents", "skills", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: About ${name}\n---\n\n# ${name}\nBODY-OF-${name}\n`);
  }
  handler = createServerHandler({ dataDir: join(dir, "data"), controlPlane: cp, now: () => clock, logger: () => {} });
});
afterEach(() => {
  handler.close();
  closeAllDbs();
  Environment.unlockDefault();
  if (savedRouter === undefined) delete process.env.HARBOR_SYSTEM_ONE_URL;
  else process.env.HARBOR_SYSTEM_ONE_URL = savedRouter;
  rmSync(dir, { recursive: true, force: true });
});

async function rpc(token: string, body: unknown, o: { session?: string; onBehalf?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}`, ...o.headers };
  if (o.session) headers["mcp-session-id"] = o.session;
  if (o.onBehalf) headers[ON_BEHALF_OF_HEADER] = o.onBehalf;
  return handler.fetch(new Request(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }));
}
async function open(token: string, onBehalf?: string): Promise<string> {
  const res = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, onBehalf ? { onBehalf } : {});
  expect(res.status).toBe(200);
  return res.headers.get("mcp-session-id") as string;
}
async function call(token: string, sid: string, name: string, args: Record<string, unknown> = {}, onBehalf?: string): Promise<{ status: number; text: string; isError: boolean }> {
  const res = await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, { session: sid, ...(onBehalf ? { onBehalf } : {}) });
  if (res.status !== 200) return { status: res.status, text: await res.text(), isError: true };
  const b = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { status: 200, text: b.result.content.map((c) => c.text).join("\n"), isError: Boolean(b.result.isError) };
}

describe("the default room is not a wildcard on a server", () => {
  test("a token for the UNCONFIGURED default room reads nothing — not another room's skills, labeled or not", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "general" }); // allowed: a fresh install has no `general` section
    const sid = await open(token);
    for (const skill of ["payroll-run", "ledger-close", "nda-review"]) {
      const r = await call(token, sid, "read_skill", { skill_name: skill });
      expect(r.isError, skill).toBe(true);
      expect(r.text).not.toContain("BODY-OF");
    }
    expect((await call(token, sid, "list_skills")).text).toContain("No skills");
    expect((await call(token, sid, "search_skills", { query: "payroll ledger nda" })).text).not.toContain("payroll-run");
  });

  test("...even with a ceiling that would admit an internal skill from another room", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "general", maxSensitivity: "restricted" });
    const sid = await open(token);
    expect((await call(token, sid, "read_skill", { skill_name: "nda-review" })).isError).toBe(true);
    expect((await call(token, sid, "activate_skill", { skill_name: "ledger-close" })).isError).toBe(true);
  });

  test("a delegate grant for the unconfigured default room reaches nothing either", async () => {
    const delegate = cp.createToken({ tenantId: "acme", delegate: true }).token;
    cp.setGrant("acme", "kim@example.com", { room: "general", clearance: "restricted" });
    const sid = await open(delegate, "kim@example.com");
    expect((await call(delegate, sid, "read_skill", { skill_name: "ledger-close" }, "kim@example.com")).isError).toBe(true);
    expect((await call(delegate, sid, "read_skill", { skill_name: "payroll-run" }, "kim@example.com")).isError).toBe(true);
  });

  test("once the default room IS configured with a skill list, it works like any other room", async () => {
    writeConfig(`\n[skills.rooms.general]\nskills = ["nda-review"]\ncapabilities = ${JSON.stringify(CAPS)}\n`);
    bump();
    const { token } = cp.createToken({ tenantId: "acme", room: "general" });
    const sid = await open(token);
    expect((await call(token, sid, "read_skill", { skill_name: "nda-review" })).text).toContain("BODY-OF-nda-review");
    expect((await call(token, sid, "read_skill", { skill_name: "ledger-close" })).isError).toBe(true);
  });
});

describe("a session follows the room's capabilities, not the ones it was opened with", () => {
  test("removing read_skill from the room ends open sessions; the next one is denied", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    const sid = await open(token);
    expect((await call(token, sid, "read_skill", { skill_name: "nda-review" })).text).toContain("BODY-OF-nda-review");

    writeConfig();
    writeFileSync(
      join(cp.tenantRoot("acme"), ".agent-env", "config.toml"),
      `[paths]\nhome = ${JSON.stringify(cp.tenantRoot("acme"))}\n\n[skills.rooms.legal]\nskills = ["nda-review", "payroll-run"]\ncapabilities = ["list_skills"]\n`,
    );
    bump();
    const stale = await call(token, sid, "read_skill", { skill_name: "nda-review" });
    expect(stale.status).toBe(404); // not served with the old capabilities: re-initialize
    const fresh = await open(token);
    const denied = await call(token, fresh, "read_skill", { skill_name: "nda-review" });
    expect(denied.isError).toBe(true);
    expect(denied.text).not.toContain("BODY-OF");
    expect((await call(token, fresh, "list_skills")).isError).toBe(false); // what is still granted still works
  });

  test("an unrelated config edit does not end sessions", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    const sid = await open(token);
    writeConfig("\n[skills.rooms.finance2]\nskills = []\n");
    bump();
    expect((await call(token, sid, "list_skills")).status).toBe(200);
  });
});

describe("pinned by mutations the suite used to miss", () => {
  test("admin needs BOTH the operator's allow-admin AND 'admin' in the token's capabilities", () => {
    const auth = (over: Record<string, unknown>) =>
      ({ ok: true, tenantId: "t", room: "r", tokenId: "i", capabilities: null, adminAllowed: false, principal: "", dailyTokenQuota: null, dailyReadQuota: null, maxSensitivity: null, delegate: false, ...over }) as Parameters<typeof sessionCapabilities>[1];
    expect(sessionCapabilities(["read_skill"], auth({ adminAllowed: true, capabilities: ["read_skill"] }))).toEqual(["read_skill"]);
    expect(sessionCapabilities(["read_skill"], auth({ adminAllowed: true, capabilities: null }))).toEqual(["read_skill"]);
    expect(sessionCapabilities(["read_skill"], auth({ adminAllowed: false, capabilities: ["read_skill", "admin"] }))).toEqual(["read_skill"]);
    expect(sessionCapabilities(["read_skill"], auth({ adminAllowed: true, capabilities: ["read_skill", "admin"] }))).toEqual(["read_skill", "admin"]);
  });

  test("the sweep drops idle sessions, so they stop counting toward the cap", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    await open(token);
    await open(token);
    expect(handler.sessionCount()).toBe(2);
    handler.sweep();
    expect(handler.sessionCount()).toBe(2); // not idle yet
    clock += 3_700_000; // past the default 3600 s idle limit
    handler.sweep();
    expect(handler.sessionCount()).toBe(0);
  });

  test("an unsupported MCP-Protocol-Version is refused; a supported one is not", async () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const bad = await rpc(token, init, { headers: { "mcp-protocol-version": "1999-01-01" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("unsupported_protocol_version");
    expect((await rpc(token, init, { headers: { "mcp-protocol-version": "2025-06-18" } })).status).toBe(200);
    expect((await rpc(token, init)).status).toBe(200); // absent = the back-compat default
  });

  test("a token is expired AT its expiry instant, not one tick after", () => {
    const { token, record } = cp.createToken({ tenantId: "acme", room: "legal", ttlSeconds: 100 });
    const at = record.expiresAt as number;
    expect(cp.authenticate(token, at - 0.001).ok).toBe(true);
    expect(cp.authenticate(token, at)).toEqual({ ok: false, reason: "expired" });
    expect(cp.authenticate(token, at + 1)).toEqual({ ok: false, reason: "expired" });
  });
});
