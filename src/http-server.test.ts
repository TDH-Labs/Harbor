import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAllDbs } from "./db.ts";
import { Environment } from "./env.ts";
import { createServerHandler, sessionCapabilities, startServer, type ServerHandler, type ServerOptions } from "./http-server.ts";
import { auditRead } from "./isolation.ts";
import { ControlPlane } from "./tenants.ts";

// Real time as the base, because tokens stamp `Date.now()` at creation; the
// injectable clock then moves FORWARD from it for expiry / idle / rate tests.
let clock: number;
let dir: string;
let cp: ControlPlane;
let handler: ServerHandler;
let logs: Array<Record<string, unknown>>;
const savedRouter = process.env.HARBOR_SYSTEM_ONE_URL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-http-"));
  clock = Date.now();
  logs = [];
  cp = new ControlPlane(join(dir, "data"));
  // No test may depend on a router the developer happens to be running.
  process.env.HARBOR_SYSTEM_ONE_URL = "http://127.0.0.1:59992";
});
afterEach(() => {
  handler?.close();
  closeAllDbs();
  Environment.unlockDefault();
  if (savedRouter === undefined) delete process.env.HARBOR_SYSTEM_ONE_URL;
  else process.env.HARBOR_SYSTEM_ONE_URL = savedRouter;
  rmSync(dir, { recursive: true, force: true });
});

function serve(extra: Partial<ServerOptions> = {}): ServerHandler {
  handler = createServerHandler({
    dataDir: join(dir, "data"),
    controlPlane: cp,
    now: () => clock,
    logger: (e) => logs.push(e),
    ...extra,
  });
  return handler;
}

interface Seed {
  rooms: Record<string, { skills: string[]; capabilities?: string[] }>;
  skills: Record<string, string>;
}
function seedTenant(id: string, seed: Seed): void {
  cp.createTenant(id);
  const root = cp.tenantRoot(id);
  const toml = Object.entries(seed.rooms)
    .map(
      ([room, v]) =>
        `[skills.rooms.${room}]\nskills = ${JSON.stringify(v.skills)}\n` +
        (v.capabilities ? `capabilities = ${JSON.stringify(v.capabilities)}\n` : ""),
    )
    .join("\n");
  writeFileSync(join(root, ".agent-env", "config.toml"), toml);
  for (const [name, desc] of Object.entries(seed.skills)) {
    const d = join(root, ".agents", "skills", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nBody of ${name}.\n`);
  }
}

const BASE = "http://harbor.test";
type Json = Record<string, any>;

async function post(
  token: string | null,
  body: unknown,
  opts: { session?: string; headers?: Record<string, string>; raw?: string; path?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.session) headers["mcp-session-id"] = opts.session;
  return handler.fetch(
    new Request(`${BASE}${opts.path ?? "/mcp"}`, {
      method: "POST",
      headers,
      body: opts.raw ?? JSON.stringify(body),
    }),
  );
}

async function init(token: string, extra: Record<string, string> = {}): Promise<string> {
  const res = await post(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { headers: extra });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toMatch(/^[0-9a-f]{32}$/);
  return sid as string;
}

async function call(token: string, session: string, name: string, args: Json = {}, id = 2): Promise<{ text: string; isError: boolean; status: number }> {
  const res = await post(token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, { session });
  if (res.status !== 200) return { text: await res.text(), isError: true, status: res.status };
  const body = (await res.json()) as Json;
  return {
    text: (body.result.content as Array<{ text: string }>).map((c) => c.text).join("\n"),
    isError: Boolean(body.result.isError),
    status: 200,
  };
}

const READ_CAPS = ["read_skill", "list_skills", "search_skills", "activate_skill", "deactivate_skill"];

function twoTenants(): { a: string; b: string } {
  seedTenant("acme", {
    rooms: {
      legal: { skills: ["nda-review", "acme-secret"], capabilities: READ_CAPS },
      finance: { skills: ["payroll-secrets"], capabilities: READ_CAPS },
    },
    skills: { "nda-review": "Review NDA agreements", "acme-secret": "Acme only", "payroll-secrets": "Run payroll" },
  });
  seedTenant("globex", {
    rooms: { legal: { skills: ["globex-secret"], capabilities: READ_CAPS } },
    skills: { "globex-secret": "Globex only" },
  });
  return {
    a: cp.createToken({ tenantId: "acme", room: "legal" }).token,
    b: cp.createToken({ tenantId: "globex", room: "legal" }).token,
  };
}

// ── plumbing ─────────────────────────────────────────────────────────────────

describe("liveness, readiness, routing", () => {
  test("/healthz and /readyz need no auth; HEAD works", async () => {
    serve();
    for (const [path, method] of [["/healthz", "GET"], ["/healthz", "HEAD"], ["/readyz", "GET"]] as const) {
      const res = await handler.fetch(new Request(BASE + path, { method }));
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect(((await (await handler.fetch(new Request(BASE + "/readyz"))).json()) as Json).status).toBe("ready");
  });

  test("unknown paths 404; wrong methods 405 with Allow", async () => {
    serve();
    expect((await handler.fetch(new Request(BASE + "/nope"))).status).toBe(404);
    expect((await handler.fetch(new Request(BASE + "/healthz", { method: "POST" }))).status).toBe(405);
    const get = await handler.fetch(new Request(BASE + "/mcp"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, DELETE");
  });

  test("every response is nosniff + no-store", async () => {
    serve();
    const res = await handler.fetch(new Request(BASE + "/healthz"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the process default Environment is locked while the server exists", () => {
    serve();
    expect(() => Environment.default()).toThrow(/multi-tenant/);
  });
});

// ── authentication ───────────────────────────────────────────────────────────

describe("authentication", () => {
  test("no credential, wrong scheme, garbage, wrong secret, revoked, expired, suspended: one identical 401", async () => {
    seedTenant("acme", { rooms: { legal: { skills: [] } }, skills: {} });
    seedTenant("globex", { rooms: { legal: { skills: [] } }, skills: {} });
    serve();
    const good = cp.createToken({ tenantId: "acme", room: "legal" });
    const revoked = cp.createToken({ tenantId: "acme", room: "legal" });
    cp.revokeToken(revoked.record.id);
    const expiring = cp.createToken({ tenantId: "acme", room: "legal", ttlSeconds: 30 });
    const suspended = cp.createToken({ tenantId: "globex", room: "legal" });
    cp.setTenantStatus("globex", "suspended");
    clock += 31_000;

    const flipped = good.token.slice(0, -1) + (good.token.endsWith("A") ? "B" : "A");
    const attempts: Array<[string, string | null, Record<string, string>?]> = [
      ["no credential", null],
      ["basic scheme", null, { authorization: `Basic ${good.token}` }],
      ["garbage", "not-a-token"],
      ["wrong secret", flipped],
      ["revoked", revoked.token],
      ["expired", expiring.token],
      ["tenant suspended", suspended.token],
    ];
    const bodies = new Set<string>();
    for (const [label, token, headers] of attempts) {
      const res = await post(token, { jsonrpc: "2.0", id: 1, method: "ping" }, { ...(headers ? { headers } : {}) });
      expect(res.status, label).toBe(401);
      expect(res.headers.get("www-authenticate"), label).toContain("Bearer");
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1); // no oracle: every failure looks the same to the client
    // …while the OPERATOR's log says exactly why
    const reasons = logs.filter((l) => l.status === 401).map((l) => l.deny);
    expect(reasons).toEqual(["no_bearer", "no_bearer", "malformed", "bad_secret", "revoked", "expired", "tenant_suspended"]);
  });

  test("the access log never contains a token, a secret, or a request body", async () => {
    seedTenant("acme", { rooms: { legal: { skills: [] } }, skills: {} });
    serve();
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    const secret = /^hbr_[0-9a-f]{12}_(.+)$/.exec(token)![1]!;
    const sid = await init(token);
    await call(token, sid, "list_skills");
    await post("hbr_000000000000_" + "A".repeat(43), { jsonrpc: "2.0", id: 9, method: "ping", params: { canary: "BODY-CANARY" } });
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("Bearer");
    expect(dump).not.toContain("BODY-CANARY");
    expect(dump).not.toContain(sid); // session ids are logged only as 8-char prefixes
    expect(logs.some((l) => l.tenant === "acme" && String(l.token).startsWith("hbr_"))).toBe(true);
  });

  test("a token in the query string is ignored (and never logged)", async () => {
    seedTenant("acme", { rooms: { legal: { skills: [] } }, skills: {} });
    serve();
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    const res = await handler.fetch(
      new Request(`${BASE}/mcp?access_token=${token}&token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  test("revoking a token or suspending the tenant cuts off an already-open session", async () => {
    seedTenant("acme", { rooms: { legal: { skills: ["s1"], capabilities: READ_CAPS } }, skills: { s1: "one" } });
    serve();
    const t = cp.createToken({ tenantId: "acme", room: "legal" });
    const sid = await init(t.token);
    expect((await call(t.token, sid, "list_skills")).status).toBe(200);
    cp.setTenantStatus("acme", "suspended");
    expect((await call(t.token, sid, "list_skills")).status).toBe(401);
    cp.setTenantStatus("acme", "active");
    expect((await call(t.token, sid, "list_skills")).status).toBe(200);
    cp.revokeToken(t.record.id);
    expect((await call(t.token, sid, "list_skills")).status).toBe(401);
  });
});

// ── protocol ─────────────────────────────────────────────────────────────────

describe("MCP over HTTP", () => {
  test("initialize issues a session; tools/list and tools/call work through it", async () => {
    const { a } = twoTenants();
    serve();
    const res = await post(a, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const body = (await res.json()) as Json;
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("harbor");
    const sid = res.headers.get("mcp-session-id")!;

    const list = (await (await post(a, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { session: sid })).json()) as Json;
    expect(list.result.tools.map((t: Json) => t.name)).toContain("route_skills");

    const out = await call(a, sid, "read_skill", { skill_name: "nda-review" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Body of nda-review");
    expect(handler.sessionCount()).toBe(1);
  });

  test("a non-initialize call needs a session: 400 without, 404 with an unknown one", async () => {
    const { a } = twoTenants();
    serve();
    expect((await post(a, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(400);
    expect((await post(a, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { session: "f".repeat(32) })).status).toBe(404);
  });

  test("notifications and client replies get 202 with no body", async () => {
    const { a } = twoTenants();
    serve();
    const sid = await init(a);
    const n = await post(a, { jsonrpc: "2.0", method: "notifications/initialized" }, { session: sid });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
    const r = await post(a, { jsonrpc: "2.0", id: 7, result: {} }, { session: sid });
    expect(r.status).toBe(202);
  });

  test("DELETE ends the session; reuse is 404; deleting twice is 404", async () => {
    const { a } = twoTenants();
    serve();
    const sid = await init(a);
    const del = () =>
      handler.fetch(new Request(BASE + "/mcp", { method: "DELETE", headers: { authorization: `Bearer ${a}`, "mcp-session-id": sid } }));
    expect((await del()).status).toBe(204);
    expect(handler.sessionCount()).toBe(0);
    expect((await call(a, sid, "list_skills")).status).toBe(404);
    expect((await del()).status).toBe(404);
  });

  test("malformed input is rejected cleanly", async () => {
    const { a } = twoTenants();
    serve();
    const parse = await post(a, null, { raw: "{not json" });
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as Json).error.code).toBe(-32700);
    for (const raw of ["null", "42", '"str"', "[]", '[{"jsonrpc":"2.0","id":1,"method":"ping"}]']) {
      const res = await post(a, null, { raw });
      expect(res.status, raw).toBe(400);
      expect(((await res.json()) as Json).error.code, raw).toBe(-32600);
    }
    expect((await post(a, {}, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await post(a, { jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "mcp-protocol-version": "1999-01-01" } })).status).toBe(400);
  });

  test("known protocol versions are accepted", async () => {
    const { a } = twoTenants();
    serve();
    for (const v of ["2025-06-18", "2025-03-26"]) {
      const res = await post(a, { jsonrpc: "2.0", id: 1, method: "initialize" }, { headers: { "mcp-protocol-version": v } });
      expect(res.status, v).toBe(200);
    }
  });

  test("an oversized body is refused — declared or streamed", async () => {
    const { a } = twoTenants();
    serve({ maxBodyBytes: 200 });
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(500) } });
    expect((await post(a, null, { raw: big })).status).toBe(413);
    // no Content-Length (chunked): the reader enforces the cap
    const chunked = await handler.fetch(
      new Request(BASE + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a}` },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(big));
            c.close();
          },
        }),
        duplex: "half",
      }),
    );
    expect(chunked.status).toBe(413);
  });

  test("Origin: a browser page is refused unless its origin is allowed; non-browser clients (no Origin) are fine", async () => {
    const { a } = twoTenants();
    serve({ allowedOrigins: ["https://app.example"] });
    const init1 = { jsonrpc: "2.0", id: 1, method: "initialize" };
    expect((await post(a, init1, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await post(a, init1, { headers: { origin: "null" } })).status).toBe(403);
    expect((await post(a, init1, { headers: { origin: "https://app.example" } })).status).toBe(200);
    expect((await post(a, init1)).status).toBe(200);
    // the origin check runs BEFORE authentication, so a hostile page learns nothing about tokens
    expect((await post("hbr_000000000000_" + "A".repeat(43), init1, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  test("route_skills works over HTTP (keyword fallback: no router in tests)", async () => {
    const { a } = twoTenants();
    serve();
    const sid = await init(a);
    const out = await call(a, sid, "route_skills", { prompt: "please run nda-review" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("nda-review");
    expect(out.text).not.toContain("payroll-secrets"); // finance room's skill
    expect(out.text).not.toContain("globex-secret"); // another tenant's skill
  });
});

// ── the isolation guarantees ─────────────────────────────────────────────────

describe("tenant and room isolation", () => {
  test("two tenants, same room name: each sees only its own pool", async () => {
    const { a, b } = twoTenants();
    serve();
    const sa = await init(a);
    const sb = await init(b);
    const la = (await call(a, sa, "list_skills")).text;
    const lb = (await call(b, sb, "list_skills")).text;
    expect(la).toContain("nda-review");
    expect(la).toContain("acme-secret");
    expect(la).not.toContain("globex-secret");
    expect(lb).toContain("globex-secret");
    expect(lb).not.toContain("acme-secret");

    const cross = await call(b, sb, "read_skill", { skill_name: "acme-secret" });
    expect(cross.isError).toBe(true); // not in globex's pool, and not in its room
    expect(cross.text).not.toContain("Acme only");
  });

  test("tenant state is physically separate: audit rows land only in the acting tenant's database", async () => {
    const { a, b } = twoTenants();
    serve();
    const sa = await init(a);
    await init(b);
    await call(a, sa, "read_skill", { skill_name: "payroll-secrets" }); // denied: finance room
    const acme = cp.tenantEnvironment("acme");
    const globex = cp.tenantEnvironment("globex");
    expect(auditRead(acme, { room: "legal" }).some((r) => r.decision === "denied" && r.resource === "payroll-secrets")).toBe(true);
    expect(auditRead(globex, { room: "legal" }).some((r) => r.resource === "payroll-secrets")).toBe(false);
    expect(acme.isolationDb).not.toBe(globex.isolationDb);
  });

  test("the room is fixed by the token: a client cannot select another one", async () => {
    const { a } = twoTenants();
    serve();
    const sid = await init(a, { "x-agent-env-room": "finance", "agent_env_room": "finance", "x-room": "finance" });
    // Room-scoped denial for a skill outside the token's room:
    const read = await call(a, sid, "read_skill", { skill_name: "payroll-secrets" });
    expect(read.isError).toBe(true);
    expect(read.text).toContain("access denied");
    // An explicit room argument is a cross-room override and needs ADMIN:
    const listOther = await call(a, sid, "list_skills", { room: "finance" });
    expect(listOther.isError).toBe(true);
    expect(listOther.text).toContain("may not access room 'finance'"); // refused by the gate itself
    const route = await call(a, sid, "route_skills", { prompt: "payroll", room: "finance" });
    expect(route.isError).toBe(true);
    // budget_status names the session's ACTUAL room
    expect((await call(a, sid, "budget_status")).text).toContain("(room legal)");
  });

  test("a token can lower capabilities but the room config's ceiling still applies", async () => {
    seedTenant("acme", { rooms: { legal: { skills: ["s1"], capabilities: ["read_skill", "list_skills"] } }, skills: { s1: "one" } });
    serve();
    const narrow = cp.createToken({ tenantId: "acme", room: "legal", capabilities: ["list_skills", "search_skills"] });
    const sid = await init(narrow.token);
    expect((await call(narrow.token, sid, "list_skills")).isError).toBe(false);
    const read = await call(narrow.token, sid, "read_skill", { skill_name: "s1" }); // room grants it, token does not
    expect(read.isError).toBe(true);
    expect(read.text).toContain("access denied");
    const search = await call(narrow.token, sid, "search_skills", { query: "one" }); // token lists it, ROOM does not
    expect(search.isError).toBe(true);
    expect(search.text).toContain("access denied");
  });

  test("`admin` in a room's config is NOT handed to a network caller", async () => {
    seedTenant("acme", {
      rooms: {
        legal: { skills: ["s1"], capabilities: [...READ_CAPS, "admin"] },
        finance: { skills: ["s2"], capabilities: READ_CAPS },
      },
      skills: { s1: "one", s2: "two" },
    });
    serve();
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    const sid = await init(token);
    const other = await call(token, sid, "list_skills", { room: "finance" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("may not access room 'finance'");
  });

  test("…only an operator-issued admin token can cross rooms", async () => {
    seedTenant("acme", {
      rooms: { legal: { skills: ["s1"], capabilities: READ_CAPS }, finance: { skills: ["s2"], capabilities: READ_CAPS } },
      skills: { s1: "one", s2: "two" },
    });
    serve();
    const admin = cp.createToken({
      tenantId: "acme",
      room: "legal",
      capabilities: [...READ_CAPS, "admin"],
      allowAdmin: true,
    });
    const sid = await init(admin.token);
    const other = await call(admin.token, sid, "list_skills", { room: "finance" });
    expect(other.isError).toBe(false);
    expect(other.text).toContain("s2");
  });

  test("a session id is bound to its token: another token — even in the same tenant — cannot use it", async () => {
    seedTenant("acme", { rooms: { legal: { skills: ["s1"], capabilities: READ_CAPS } }, skills: { s1: "one" } });
    seedTenant("globex", { rooms: { legal: { skills: [], capabilities: READ_CAPS } }, skills: {} });
    serve();
    const t1 = cp.createToken({ tenantId: "acme", room: "legal" }).token;
    const t2 = cp.createToken({ tenantId: "acme", room: "legal" }).token;
    const other = cp.createToken({ tenantId: "globex", room: "legal" }).token;
    const sid = await init(t1);
    expect((await call(t2, sid, "list_skills")).status).toBe(404);
    expect((await call(other, sid, "list_skills")).status).toBe(404);
    expect((await call(t1, sid, "list_skills")).status).toBe(200);
  });

  test("a tenant whose config points outside its root is unavailable (503), not served", async () => {
    seedTenant("acme", { rooms: { legal: { skills: [] } }, skills: {} });
    serve();
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    writeFileSync(join(cp.tenantRoot("acme"), ".agent-env", "config.toml"), '[paths]\nskills_dir = "/etc"\n');
    const future = new Date(Date.now() + 60_000);
    (await import("node:fs")).utimesSync(join(cp.tenantRoot("acme"), ".agent-env", "config.toml"), future, future);
    const res = await post(token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("/etc");
    expect(logs.at(-1)?.error).toBe("config_escape");
  });
});

// ── limits ───────────────────────────────────────────────────────────────────

describe("limits", () => {
  test("rate limit is per token, answers 429 + Retry-After, and refills with time", async () => {
    seedTenant("acme", { rooms: { legal: { skills: [] } }, skills: {} });
    serve({ rateLimitPerMinute: 3 });
    const busy = cp.createToken({ tenantId: "acme", room: "legal" }).token;
    const calm = cp.createToken({ tenantId: "acme", room: "legal" }).token;
    const ping = (t: string) => post(t, { jsonrpc: "2.0", id: 1, method: "initialize" });
    for (let i = 0; i < 3; i++) expect((await ping(busy)).status).toBe(200);
    const limited = await ping(busy);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await ping(calm)).status).toBe(200); // another token is unaffected
    clock += 21_000; // one token refills every 20s at 3/min
    expect((await ping(busy)).status).toBe(200);
  });

  test("sessions per token are capped", async () => {
    seedTenant("acme", { rooms: { legal: { skills: [] } }, skills: {} });
    serve({ maxSessionsPerToken: 2 });
    const { token } = cp.createToken({ tenantId: "acme", room: "legal" });
    await init(token);
    await init(token);
    const third = await post(token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(third.status).toBe(429);
    expect(((await third.json()) as Json).error).toBe("too_many_sessions");
  });

  test("an idle session expires; activity keeps it alive", async () => {
    const { a } = twoTenants();
    serve({ sessionIdleSeconds: 100, rateLimitPerMinute: 10_000 });
    const sid = await init(a);
    clock += 60_000;
    expect((await call(a, sid, "list_skills")).status).toBe(200); // touches lastSeen
    clock += 60_000;
    expect((await call(a, sid, "list_skills")).status).toBe(200); // 60s since last touch: alive
    clock += 101_000;
    expect((await call(a, sid, "list_skills")).status).toBe(404); // idle too long
    expect(handler.sessionCount()).toBe(0);
  });
});

// ── capability derivation (unit) ─────────────────────────────────────────────

describe("sessionCapabilities", () => {
  const auth = (over: Partial<{ capabilities: string[] | null; adminAllowed: boolean }> = {}) => ({
    ok: true as const,
    tenantId: "t",
    room: "r",
    tokenId: "id",
    capabilities: null,
    adminAllowed: false,
    ...over,
  });
  test("no ceiling: the room's capabilities, minus admin", () => {
    expect(sessionCapabilities(["read_skill", "admin"], auth())).toEqual(["read_skill"]);
  });
  test("a ceiling intersects", () => {
    expect(sessionCapabilities(["read_skill", "list_skills"], auth({ capabilities: ["list_skills", "file_read"] }))).toEqual(["list_skills"]);
  });
  test("admin only via an operator-issued admin token", () => {
    expect(sessionCapabilities(["read_skill"], auth({ capabilities: ["read_skill", "admin"] }))).toEqual(["read_skill"]); // not allowAdmin
    expect(sessionCapabilities(["read_skill"], auth({ capabilities: ["read_skill", "admin"], adminAllowed: true }))).toEqual(["read_skill", "admin"]);
  });
});

// ── a real socket ────────────────────────────────────────────────────────────

describe("over a real socket", () => {
  test("startServer binds, serves an authenticated MCP session, and stops", async () => {
    const { a } = twoTenants();
    const server = startServer({ dataDir: join(dir, "data"), controlPlane: cp, port: 0, logger: (e) => logs.push(e) });
    handler = server;
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(base + "/healthz")).status).toBe(200);
      expect((await fetch(base + "/mcp", { method: "POST", body: "{}" })).status).toBe(401); // auth comes first

      const initRes = await fetch(base + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(initRes.status).toBe(200);
      const sid = initRes.headers.get("mcp-session-id")!;
      const list = await fetch(base + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a}`, "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_skills", arguments: {} } }),
      });
      const body = (await list.json()) as Json;
      expect(body.result.content[0].text).toContain("nda-review");
    } finally {
      await server.stop();
    }
    await expect(fetch(`http://127.0.0.1:${server.port}/healthz`)).rejects.toThrow();
  });

  test("stop() drains: an in-flight request finishes, a new one is refused with 503, then the port closes", async () => {
    const { a } = twoTenants();
    const server = startServer({ dataDir: join(dir, "data"), controlPlane: cp, port: 0, logger: () => {}, graceMs: 3000 });
    handler = server;
    const base = `http://127.0.0.1:${server.port}`;

    // Start a request whose body we hold open, so it is genuinely in flight.
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        finish = () => {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })));
          c.close();
        };
      },
    });
    const inflight = fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a}` },
      body,
      duplex: "half",
    } as RequestInit);
    await new Promise((r) => setTimeout(r, 50));

    const stopping = server.stop();
    await new Promise((r) => setTimeout(r, 50));
    // While draining: new work is refused, readiness fails, liveness stays up.
    const refused = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("connection")).toBe("close");
    expect((await fetch(base + "/readyz")).status).toBe(503);
    expect((await fetch(base + "/healthz")).status).toBe(200);

    finish(); // let the in-flight request complete
    const done = await inflight;
    expect(done.status).toBe(200); // it was NOT cut off
    await stopping;
    await expect(fetch(base + "/healthz")).rejects.toThrow();
  });
});
