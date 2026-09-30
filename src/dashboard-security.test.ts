import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import {
  DASHBOARD_SCRIPT,
  MIN_TOKEN_LENGTH,
  createDashboardApp,
  isLoopbackHost,
  startDashboard,
} from "./dashboard.ts";
import { Environment } from "./env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-dash-sec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

const TOKEN = "correct-horse-battery-staple-42";

// ── The frontend: run the REAL page script against hostile API data ──────────

const XSS = `<img src=x onerror=alert(1)>`;
const QUOTES = `"><script>alert(2)</script>'`;

interface FakeNode {
  innerHTML: string;
  textContent: string;
  classList: { add(c: string): void; remove(c: string): void };
}

async function runPage(api: Record<string, unknown>) {
  const nodes = new Map<string, FakeNode>();
  const node = (id: string): FakeNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { innerHTML: "", textContent: "", classList: { add() {}, remove() {} } };
      nodes.set(id, n);
    }
    return n;
  };
  const bars: Array<{ style: { width?: string }; getAttribute(n: string): string | null }> = [];
  const document = {
    getElementById: node,
    querySelectorAll: (sel: string) => (sel === "[data-pct]" ? bars : []),
  };
  const sockets: Array<{ onmessage?: (ev: { data: string }) => void }> = [];
  class FakeWS {
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (ev: { data: string }) => void;
    constructor(public url: string) {
      sockets.push(this);
    }
  }
  const fetchStub = async (path: string) => ({
    ok: path in api,
    status: path in api ? 200 : 404,
    json: async () => api[path],
  });
  new Function("document", "fetch", "WebSocket", "location", "setInterval", "setTimeout", DASHBOARD_SCRIPT)(
    document,
    fetchStub,
    FakeWS,
    { protocol: "http:", host: "x" },
    () => 0,
    () => 0,
  );
  await new Promise((r) => setTimeout(r, 25));
  return { node, sockets, nodes, bars };
}

describe("dashboard frontend escapes everything it renders", () => {
  const hostileApi = {
    "/api/health": { watcher: { running: true, pid: XSS }, beacons: { [XSS]: { fresh: true } } },
    "/api/skills": { total: XSS, assigned: XSS, unassigned: XSS },
    "/api/skill-health": {
      orphans: XSS,
      total: XSS,
      byRoom: { [XSS]: { skillCount: XSS, hasIndex: true, indexAgeMinutes: 3 } },
    },
    "/api/mcp": { [XSS]: { servers: [{ name: XSS, commandOk: true, envOk: true }] } },
    "/api/rooms": { [XSS]: { skillCount: XSS, hasIndex: true } },
    "/api/scheduler": { exists: true, counts: { [XSS]: XSS } },
    "/api/budgets": {
      budgets: {
        [XSS]: { classified: XSS, percent: `50" onmouseover="alert(3)`, used: XSS, limit: XSS },
      },
    },
    "/api/audit": {
      denialsToday: XSS,
      entries: [{ timestamp: 1, room: XSS, event: QUOTES, decision: XSS }],
    },
    "/api/sessions": { sessions: [{ room: XSS, tokensUsed: XSS, tokenLimit: XSS, status: QUOTES }] },
    "/api/hypervisor": {
      count: 1,
      activeSpawns: [{ command: XSS, room: XSS, budgetRemaining: XSS, budget: XSS }],
    },
  };

  test("no panel ever contains a raw tag from the API", async () => {
    const { node } = await runPage(hostileApi);
    for (const id of ["health", "skills", "skillhealth", "mcp", "rooms", "scheduler", "budgets", "audit", "sessions", "hypervisor"]) {
      const html = node(id).innerHTML;
      expect(html, `#${id} rendered nothing`).not.toBe("");
      expect(html, `#${id} contains a raw <img`).not.toContain("<img");
      expect(html, `#${id} contains a raw <script`).not.toContain("<script");
      expect(html, `#${id} contains an unescaped attribute break`).not.toContain(`onmouseover="`);
      expect(html.includes("&lt;img") || html.includes("&lt;script") || html.includes("&quot;"), `#${id} shows the text escaped`).toBe(
        true,
      );
    }
  });

  test("a hostile percent cannot inject an attribute, and the bar width goes through the CSSOM", async () => {
    const { node, bars } = await runPage(hostileApi);
    expect(node("budgets").innerHTML).toContain('data-pct="0"'); // NaN → 0, never the raw string
    expect(node("budgets").innerHTML).not.toContain("style=");
    // an unknown band falls back to a fixed class instead of echoing the payload
    expect(node("budgets").innerHTML).toContain('class="g"');
    expect(bars).toEqual([]); // the stub found none; the real page queries [data-pct]
  });

  test("live hypervisor events pushed over the socket are escaped too", async () => {
    const { node, sockets } = await runPage(hostileApi);
    expect(sockets).toHaveLength(1);
    sockets[0]!.onmessage!({
      data: JSON.stringify({
        type: "hypervisor",
        payload: { timestamp: 1, kind: "gate", event: XSS, room: QUOTES, resource: "<script>alert(4)</script>" },
      }),
    });
    const feed = node("hypfeed").innerHTML;
    expect(feed).not.toContain("<script");
    expect(feed).not.toContain("<img");
    expect(feed).toContain("&lt;script&gt;alert(4)&lt;/script&gt;");
  });

  test("benign data still renders as data (escaping is not a blanket wipe)", async () => {
    const { node } = await runPage({
      ...hostileApi,
      "/api/rooms": { legal: { skillCount: 7, hasIndex: true } },
    });
    expect(node("rooms").innerHTML).toContain("<td>legal</td>");
    expect(node("rooms").innerHTML).toContain("7 skills");
  });

  test("a 401 tells the operator what to do instead of failing silently", async () => {
    const { node } = await runPage({}); // every endpoint 404s → not the 401 path
    expect(node("health").textContent).toBe("");
    const nodes = new Map<string, FakeNode>();
    const n = (id: string) => nodes.get(id) ?? (nodes.set(id, { innerHTML: "", textContent: "", classList: { add() {}, remove() {} } }), nodes.get(id)!);
    new Function("document", "fetch", "WebSocket", "location", "setInterval", "setTimeout", DASHBOARD_SCRIPT)(
      { getElementById: n, querySelectorAll: () => [] },
      async () => ({ ok: false, status: 401, json: async () => ({}) }),
      class {},
      { protocol: "http:", host: "x" },
      () => 0,
      () => 0,
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(n("health").textContent).toContain("unauthorized");
  });
});

// ── CSP + headers ────────────────────────────────────────────────────────────

describe("page headers", () => {
  test("a fresh nonce per response, nonce-only script/style, no unsafe-inline, no framing", async () => {
    const app = createDashboardApp(env());
    const a = await app.request("http://localhost/");
    const b = await app.request("http://localhost/");
    const csp = a.headers.get("content-security-policy") ?? "";
    const nonceA = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    const nonceB = /script-src 'nonce-([^']+)'/.exec(b.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonceA).toBeTruthy();
    expect(nonceA).not.toBe(nonceB);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    const html = await a.text();
    expect(html).toContain(`<script nonce="${nonceA}">`);
    expect(html).toContain(`<style nonce="${nonceA}">`);
    expect(a.headers.get("x-frame-options")).toBe("DENY");
  });

  test("API responses are not sniffable or cacheable", async () => {
    const res = await createDashboardApp(env()).request("http://localhost/api/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ── Host / Origin guards (tokenless loopback default) ────────────────────────

describe("Host and Origin guards", () => {
  test("loopback names are served; any other Host is refused (DNS rebinding)", async () => {
    const app = createDashboardApp(env());
    for (const host of ["localhost", "127.0.0.1", "[::1]", "127.1.2.3"]) {
      expect((await app.request(`http://${host}/api/health`)).status, host).toBe(200);
    }
    for (const host of ["evil.example", "192.168.1.5", "127.0.0.1.evil.example", "localhost.evil.example"]) {
      expect((await app.request(`http://${host}/api/health`)).status, host).toBe(403);
    }
  });

  test("allowedHosts opens a specific name", async () => {
    const app = createDashboardApp(env(), { allowedHosts: ["dash.internal"] });
    expect((await app.request("http://dash.internal/api/health")).status).toBe(200);
    expect((await app.request("http://other.internal/api/health")).status).toBe(403);
  });

  test("a cross-origin request is refused even on an allowed host", async () => {
    const app = createDashboardApp(env());
    const get = (origin: string) => app.request("http://localhost/api/health", { headers: { Origin: origin } });
    expect((await get("https://evil.example")).status).toBe(403);
    expect((await get("null")).status).toBe(403);
    expect((await get("not a url")).status).toBe(403);
    expect((await get("http://localhost")).status).toBe(200); // same origin
    expect((await get("http://localhost:9999")).status).toBe(403); // different port = different origin
  });

  test("isLoopbackHost", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.9.9.9", "::1", "[::1]"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["0.0.0.0", "::", "10.0.0.1", "example.com", "127.0.0.1.evil.com", ""]) expect(isLoopbackHost(h), h).toBe(false);
  });
});

// ── Token auth ────────────────────────────────────────────────────────────────

describe("token auth", () => {
  const app = () => createDashboardApp(env(), { token: TOKEN });
  const ok = (r: Response) => r.status;

  test("everything is refused without a credential — page, API, and the live socket path", async () => {
    const a = app();
    for (const path of ["/", "/api/health", "/api/audit", "/api/live"]) {
      const r = await a.request(`http://localhost${path}`);
      expect(ok(r), path).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  test("a bearer header works; a wrong or truncated one does not", async () => {
    const a = app();
    const withAuth = (t: string) => a.request("http://localhost/api/health", { headers: { Authorization: `Bearer ${t}` } });
    expect(ok(await withAuth(TOKEN))).toBe(200);
    expect(ok(await withAuth(TOKEN.slice(0, -1)))).toBe(401);
    expect(ok(await withAuth(TOKEN + "x"))).toBe(401);
    expect(ok(await withAuth(""))).toBe(401);
    const basic = await a.request("http://localhost/api/health", { headers: { Authorization: `Basic ${TOKEN}` } });
    expect(ok(basic)).toBe(401);
  });

  test("?token= trades the secret for an HttpOnly SameSite=Strict cookie and leaves the URL", async () => {
    const a = app();
    const r = await a.request(`http://localhost/?token=${TOKEN}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("harbor_dash=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const jar = cookie.split(";")[0]!;
    expect(ok(await a.request("http://localhost/api/health", { headers: { Cookie: jar } }))).toBe(200);
  });

  test("a wrong ?token= gets no cookie", async () => {
    const r = await app().request("http://localhost/?token=wrong-wrong-wrong-wrong");
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie") ?? "").not.toMatch(/harbor_dash=[^;]+/);
  });

  test("?token= is honored only on GET, and other query params survive the redirect", async () => {
    const a = app();
    const post = await a.request(`http://localhost/api/health?token=${TOKEN}`, { method: "POST" });
    expect(post.status).toBe(401);
    const r = await a.request(`http://localhost/api/health?a=1&token=${TOKEN}&b=2`);
    expect(r.headers.get("location")).toBe("/api/health?a=1&b=2");
  });

  test("a forged cookie value is refused", async () => {
    const r = await app().request("http://localhost/api/health", { headers: { Cookie: "harbor_dash=forged" } });
    expect(r.status).toBe(401);
  });

  test(`a token shorter than ${MIN_TOKEN_LENGTH} characters is rejected at construction`, () => {
    expect(() => createDashboardApp(env(), { token: "short" })).toThrow(/at least/);
  });

  test("the Origin guard still applies to an authenticated request", async () => {
    const r = await app().request("http://localhost/api/health", {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" },
    });
    expect(r.status).toBe(403);
  });
});

// ── Bind policy + a real socket ──────────────────────────────────────────────

describe("startDashboard bind policy", () => {
  test("refuses a non-loopback host without a token", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(() => startDashboard(env(), { port: 0, host }), host).toThrow(/without a token/);
    }
  });

  test("refuses a weak token before binding anything", () => {
    expect(() => startDashboard(env(), { port: 0, token: "abc" })).toThrow(/at least/);
  });

  test("loopback needs no token; a token is allowed anywhere", () => {
    const a = startDashboard(env(), { port: 0 });
    const b = startDashboard(env(), { port: 0, token: TOKEN });
    try {
      expect(a.host).toBe("127.0.0.1");
      expect(b.port).toBeGreaterThan(0);
    } finally {
      a.stop();
      b.stop();
    }
  });
});

describe("over a real socket", () => {
  test("token required: 401 without it, 200 with it", async () => {
    const server = startDashboard(env(), { port: 0, token: TOKEN });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/api/health`)).status).toBe(401);
      const ok = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { status: string }).status).toBe("ok");
    } finally {
      server.stop();
    }
  });

  function openSocket(url: string, headers: Record<string, string>): Promise<"open" | "refused"> {
    return new Promise((resolve) => {
      // Bun's WebSocket client accepts a headers option (a browser would send Origin itself).
      const ws = new WebSocket(url, { headers } as unknown as string[]);
      const timer = setTimeout(() => resolve("refused"), 1500);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve("open");
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve("refused");
      };
    });
  }

  test("the live socket refuses a cross-site Origin (no cross-site hijacking of the event stream)", async () => {
    const server = startDashboard(env(), { port: 0 });
    try {
      const url = `ws://127.0.0.1:${server.port}/api/live`;
      expect(await openSocket(url, { Origin: "https://evil.example" })).toBe("refused");
      expect(await openSocket(url, {})).toBe("open"); // a non-browser local client is fine
      expect(await openSocket(url, { Origin: `http://127.0.0.1:${server.port}` })).toBe("open");
    } finally {
      server.stop();
    }
  });

  test("the live socket needs the token when one is configured", async () => {
    const server = startDashboard(env(), { port: 0, token: TOKEN });
    try {
      const url = `ws://127.0.0.1:${server.port}/api/live`;
      expect(await openSocket(url, {})).toBe("refused");
      expect(await openSocket(url, { Authorization: `Bearer ${TOKEN}` })).toBe("open");
    } finally {
      server.stop();
    }
  });
});
