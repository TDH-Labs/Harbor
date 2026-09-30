/**
 * delegate-client.test.ts — the house-agent client, run against the REAL server
 * handler (no mocks of Harbor): identities, per-person sessions, and the errors.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAllDbs } from "../src/db.ts";
import { Environment } from "../src/env.ts";
import { createServerHandler, type ServerHandler } from "../src/http-server.ts";
import { ControlPlane } from "../src/tenants.ts";
import {
  DelegateAuthError,
  DelegateClient,
  DelegateError,
  DelegateForbiddenError,
  DelegateRateLimitedError,
  IdentityMap,
  ON_BEHALF_OF_HEADER,
  UnknownIdentityError,
  UnverifiedIdentityError,
  VerifiedIdentity,
} from "./delegate-client.ts";

const READ_CAPS = ["read_skill", "list_skills", "search_skills", "activate_skill", "deactivate_skill"];
const ENDPOINT = "http://harbor.test/mcp";

let dir: string;
let cp: ControlPlane;
let handler: ServerHandler;
let token: string;
let requests: Array<{ method: string; person: string | null; hasSession: boolean; rpc: string }>;
const savedRouter = process.env.HARBOR_SYSTEM_ONE_URL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-dclient-"));
  process.env.HARBOR_SYSTEM_ONE_URL = "http://127.0.0.1:59992";
  cp = new ControlPlane(join(dir, "data"));
  cp.createTenant("acme");
  const root = cp.tenantRoot("acme");
  const rooms: Record<string, string[]> = { legal: ["nda-review", "payroll-run"], finance: ["ledger-close"] };
  writeFileSync(
    join(root, ".agent-env", "config.toml"),
    `[paths]\nhome = ${JSON.stringify(root)}\n\n` +
      Object.entries(rooms)
        .map(([r, s]) => `[skills.rooms.${r}]\nskills = ${JSON.stringify(s)}\ncapabilities = ${JSON.stringify(READ_CAPS)}\n`)
        .join("\n") +
      `\n[skills.skill_sensitivity]\nnda-review = "internal"\npayroll-run = "restricted"\nledger-close = "restricted"\n`,
  );
  for (const name of Object.values(rooms).flat()) {
    const d = join(root, ".agents", "skills", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: About ${name}\n---\n\n# ${name}\n`);
  }
  cp.setGrant("acme", "kim@example.com", { room: "legal", clearance: "internal" });
  cp.setGrant("acme", "lee@example.com", { room: "finance", clearance: "restricted" });
  token = cp.createToken({ tenantId: "acme", delegate: true, label: "son-of-anton" }).token;
  handler = createServerHandler({ dataDir: join(dir, "data"), controlPlane: cp, logger: () => {} });
  requests = [];
});
afterEach(() => {
  handler.close();
  closeAllDbs();
  Environment.unlockDefault();
  if (savedRouter === undefined) delete process.env.HARBOR_SYSTEM_ONE_URL;
  else process.env.HARBOR_SYSTEM_ONE_URL = savedRouter;
  rmSync(dir, { recursive: true, force: true });
});

const ids = new IdentityMap([
  ["slack:U-KIM", "kim@example.com"],
  ["web:kim-sso-sub", "kim@example.com"], // the same person on a second channel
  ["slack:U-LEE", "lee@example.com"],
  ["slack:U-GHOST", "ghost@example.com"], // mapped, but Harbor has no grant for them
]);
const kim = () => VerifiedIdentity.authenticated("slack", "U-KIM");
const lee = () => VerifiedIdentity.authenticated("slack", "U-LEE");

function newClient(over: { token?: string; identities?: IdentityMap } = {}): DelegateClient {
  return new DelegateClient({
    endpoint: ENDPOINT,
    token: over.token ?? token,
    identities: over.identities ?? ids,
    fetch: async (input, init) => {
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as { method?: string }) : null;
      requests.push({
        method: init.method ?? "GET",
        person: headers.get(ON_BEHALF_OF_HEADER),
        hasSession: headers.has("mcp-session-id"),
        rpc: body?.method ?? "-",
      });
      return handler.fetch(new Request(input, init));
    },
  });
}
const names = (text: string): string[] => [...text.matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1] as string);
const inits = (): number => requests.filter((r) => r.rpc === "initialize").length;

describe("identities", () => {
  test("a look-alike object is not a VerifiedIdentity, and nothing is sent", () => {
    const c = newClient();
    for (const fake of [{ channel: "slack", subject: "U-KIM", key: "slack:U-KIM" }, "kim@example.com", null, Object.create(VerifiedIdentity.prototype)]) {
      expect(() => c.forIdentity(fake as never), JSON.stringify(fake)).toThrow(UnverifiedIdentityError);
    }
    expect(requests).toEqual([]);
  });

  test("an identity nobody mapped is refused before any request", () => {
    const c = newClient();
    expect(() => c.forIdentity(VerifiedIdentity.authenticated("slack", "U-STRANGER"))).toThrow(UnknownIdentityError);
    expect(() => c.forIdentity(VerifiedIdentity.authenticated("discord", "U-KIM"))).toThrow(UnknownIdentityError); // right subject, wrong channel
    expect(requests).toEqual([]);
  });

  test("authenticated() and the map reject malformed input", () => {
    expect(() => VerifiedIdentity.authenticated("", "x")).toThrow(UnverifiedIdentityError);
    expect(() => VerifiedIdentity.authenticated("sl ack", "x")).toThrow(UnverifiedIdentityError);
    expect(() => VerifiedIdentity.authenticated("slack:", "x")).toThrow(UnverifiedIdentityError);
    expect(() => VerifiedIdentity.authenticated("slack", "")).toThrow(UnverifiedIdentityError);
    expect(() => new IdentityMap([["slack:U1", "kim\r\nX-Injected: 1"]])).toThrow(/invalid person/);
    expect(() => new IdentityMap([["slack:U1", "a b"]])).toThrow(/invalid person/);
    expect(() => new IdentityMap([["nocolon", "kim"]])).toThrow(/channel:subject/);
    expect(() => new IdentityMap([["slack:U1", "kim"], ["slack:U1", "lee"]])).toThrow(/mapped twice/);
    // a map cannot be asked about a look-alike either
    expect(() => ids.resolve({ channel: "slack", subject: "U-KIM", key: "slack:U-KIM" } as never)).toThrow(UnverifiedIdentityError);
  });
});

describe("acting for people", () => {
  test("each person gets exactly their own grant, from one delegate token", async () => {
    const c = newClient();
    const k = c.forIdentity(kim());
    const l = c.forIdentity(lee());
    expect(names((await k.callTool("list_skills")).text)).toEqual(["nda-review"]); // internal ceiling
    expect(names((await l.callTool("list_skills")).text)).toEqual(["ledger-close"]);
    expect((await k.callTool("read_skill", { skill_name: "payroll-run" })).isError).toBe(true);
    expect((await k.callTool("read_skill", { skill_name: "nda-review" })).text).toContain("# nda-review");
    expect((await l.callTool("read_skill", { skill_name: "nda-review" })).isError).toBe(true); // legal is not lee's room
  });

  test("the person header is on every request and is the mapped person — never anything from the arguments", async () => {
    const c = newClient();
    const k = c.forIdentity(kim());
    await k.callTool("list_skills", { room: "finance", on_behalf_of: "lee@example.com" }); // hostile-looking arguments
    await k.callTool("budget_status");
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(new Set(requests.map((r) => r.person))).toEqual(new Set(["kim@example.com"]));
  });

  test("two channel identities for one person share a session; two people never do", async () => {
    const c = newClient();
    const a = c.forIdentity(kim());
    const b = c.forIdentity(VerifiedIdentity.authenticated("web", "kim-sso-sub"));
    expect(a).toBe(b);
    expect(a.person).toBe("kim@example.com");
    await a.callTool("list_skills");
    await b.callTool("list_skills");
    expect(inits()).toBe(1);
    await c.forIdentity(lee()).callTool("list_skills");
    expect(inits()).toBe(2);
    expect(c.forIdentity(lee())).not.toBe(a);
  });

  test("one initialize per person, however many calls are in flight", async () => {
    const c = newClient();
    const k = c.forIdentity(kim());
    const out = await Promise.all([k.callTool("list_skills"), k.callTool("list_skills"), k.callTool("budget_status"), k.listTools()]);
    expect(out).toHaveLength(4);
    expect(inits()).toBe(1);
    await k.callTool("list_skills");
    expect(inits()).toBe(1); // and the session is reused afterwards
  });

  test("a changed grant ends the session; the client re-opens once and the person sees the NEW entitlements", async () => {
    const c = newClient();
    const k = c.forIdentity(kim());
    expect(names((await k.callTool("list_skills")).text)).toEqual(["nda-review"]);
    cp.setGrant("acme", "kim@example.com", { room: "legal", clearance: "restricted" }); // raised
    expect(names((await k.callTool("list_skills")).text).sort()).toEqual(["nda-review", "payroll-run"]);
    expect(inits()).toBe(2);
    cp.setGrant("acme", "kim@example.com", { room: "finance", clearance: "restricted" }); // moved
    expect(names((await k.callTool("list_skills")).text)).toEqual(["ledger-close"]);
    expect(inits()).toBe(3);
  });

  test("close() ends the session at Harbor; the next call opens a new one", async () => {
    const c = newClient();
    const k = c.forIdentity(kim());
    await k.callTool("list_skills");
    expect(handler.sessionCount()).toBe(1);
    await k.close();
    expect(handler.sessionCount()).toBe(0);
    await k.callTool("list_skills");
    expect(inits()).toBe(2);
    await k.close();
    await k.close(); // idempotent
  });
});

describe("what goes wrong", () => {
  test("a person Harbor has no grant for is DelegateForbiddenError, and other people are unaffected", async () => {
    const c = newClient();
    await expect(c.forIdentity(VerifiedIdentity.authenticated("slack", "U-GHOST")).callTool("list_skills")).rejects.toThrow(DelegateForbiddenError);
    expect((await c.forIdentity(kim()).callTool("list_skills")).isError).toBe(false);
  });

  test("suspending or ungranting a person stops the very next call", async () => {
    const c = newClient();
    const k = c.forIdentity(kim());
    await k.callTool("list_skills");
    cp.setPrincipalStatus("acme", "kim@example.com", "suspended");
    await expect(k.callTool("list_skills")).rejects.toThrow(DelegateForbiddenError);
    cp.setPrincipalStatus("acme", "kim@example.com", "active");
    expect((await k.callTool("list_skills")).isError).toBe(false);
    cp.removeGrant("acme", "kim@example.com");
    await expect(k.callTool("list_skills")).rejects.toThrow(DelegateForbiddenError);
  });

  test("a refused token is DelegateAuthError for everyone", async () => {
    const c = newClient();
    const k = c.forIdentity(kim());
    await k.callTool("list_skills");
    cp.revokeToken(cp.listTokens("acme").find((t) => t.delegate)!.id);
    await expect(k.callTool("list_skills")).rejects.toThrow(DelegateAuthError);
    await expect(c.forIdentity(lee()).callTool("list_skills")).rejects.toThrow(DelegateAuthError);
  });

  test("a rate limit is a typed error carrying Retry-After", async () => {
    handler.close();
    handler = createServerHandler({ dataDir: join(dir, "data"), controlPlane: cp, logger: () => {}, rateLimitPerMinute: 3 });
    const k = newClient().forIdentity(kim());
    await k.callTool("list_skills"); // initialize + initialized + the call = the whole allowance
    const err = await k.callTool("list_skills").catch((e) => e);
    expect(err).toBeInstanceOf(DelegateRateLimitedError);
    expect((err as DelegateRateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as DelegateRateLimitedError).status).toBe(429);
    // the limit is per person: lee is not affected by kim's
    expect((await newClient().forIdentity(lee()).callTool("list_skills")).isError).toBe(false);
  });

  test("the token never appears in an error, a dump or a string form of the client", async () => {
    const bad = "hbr_000000000000_" + "A".repeat(43);
    const c = newClient({ token: bad });
    const err = await c.forIdentity(kim()).callTool("list_skills").catch((e) => e as Error);
    expect(err).toBeInstanceOf(DelegateAuthError);
    for (const text of [String(err), (err as Error).message, (err as Error).stack ?? "", JSON.stringify(err), JSON.stringify(c), String(c), JSON.stringify(Object.entries(c))]) {
      expect(text).not.toContain(bad);
      expect(text).not.toContain("A".repeat(20));
    }
    expect(() => new DelegateClient({ endpoint: ENDPOINT, token: "", identities: ids })).toThrow(DelegateError);
  });

  test("a redirect is not followed (it would carry the bearer token elsewhere)", async () => {
    let init: RequestInit | undefined;
    const c = new DelegateClient({
      endpoint: ENDPOINT,
      token,
      identities: ids,
      fetch: async (_u, i) => {
        init = i;
        return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      },
    });
    const err = await c.forIdentity(kim()).callTool("list_skills").catch((e) => e);
    expect(init?.redirect).toBe("error");
    expect(err).toBeInstanceOf(DelegateError);
  });
});
