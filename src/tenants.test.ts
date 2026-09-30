import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config } from "./config.ts";
import { cachedDbCount, closeAllDbs, closeDbsUnder, openDb } from "./db.ts";
import { Environment } from "./env.ts";
import { Capability } from "./isolation.ts";
import { ControlPlane, TENANT_ID_RE, TenantError, tokenHandle, type TenantErrorCode } from "./tenants.ts";

let dir: string;
let cp: ControlPlane;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-tenants-"));
  cp = new ControlPlane(join(dir, "data"));
});
afterEach(() => {
  closeAllDbs();
  Environment.unlockDefault();
  rmSync(dir, { recursive: true, force: true });
});

/** Split a token into its parts. NOT `split("_")`: a base64url secret may itself contain "_". */
function parts(token: string): { id: string; secret: string } {
  const m = /^hbr_([0-9a-f]{12})_(.+)$/.exec(token);
  if (!m) throw new Error(`not a token: ${token}`);
  return { id: m[1]!, secret: m[2]! };
}

function expectCode(fn: () => unknown, code: TenantErrorCode): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TenantError);
    expect((e as TenantError).code).toBe(code);
    return;
  }
  throw new Error(`expected TenantError(${code}), nothing thrown`);
}

describe("tenant ids", () => {
  test.each(["acme", "acme-corp", "a1b", "tenant-42", "x".repeat(40)])("accepts %s", (id) => {
    expect(TENANT_ID_RE.test(id)).toBe(true);
  });
  test.each(["", "a", "ab", "..", "../x", "a/b", "A-B", "a_b", "-ab", "ab-", "a b", "x".repeat(41), "a\0b", ".hidden"])(
    "rejects %j",
    (id) => {
      expect(TENANT_ID_RE.test(id)).toBe(false);
      expectCode(() => cp.createTenant(id), "invalid_tenant_id");
    },
  );
});

describe("createTenant", () => {
  test("builds an isolated Environment tree under data/tenants/<id>", () => {
    const t = cp.createTenant("acme", { note: "first customer" });
    expect(t).toMatchObject({ id: "acme", status: "active", note: "first customer" });
    const root = join(dir, "data", "tenants", "acme");
    for (const sub of [".agent-env", ".agents/skills", "rooms", "workspace", "data", "archive"]) {
      expect(existsSync(join(root, sub)), sub).toBe(true);
    }
    expect(cp.tenantRoot("acme")).toBe(root);
  });

  test("seeds a config whose paths.home is the tenant root, so the ordinary CLI roots there (not at the operator's home)", () => {
    cp.createTenant("acme");
    const cfgPath = cp.tenantConfigPath("acme");
    expect(readFileSync(cfgPath, "utf8")).toContain(`home = ${JSON.stringify(cp.tenantRoot("acme"))}`);
    // and is loadable as an ordinary config whose root resolves to the tenant
    expect(Environment.load(cfgPath).root).toBe(cp.tenantRoot("acme"));
  });

  test("never overwrites an existing tenant config", () => {
    mkdirSync(join(cp.tenantRoot("acme"), ".agent-env"), { recursive: true });
    writeFileSync(cp.tenantConfigPath("acme"), "# operator wrote this first\n[skills.rooms.legal]\nskills = []\n");
    cp.createTenant("acme");
    expect(readFileSync(cp.tenantConfigPath("acme"), "utf8")).toContain("operator wrote this first");
  });

  test("a duplicate id is an error, and listing is stable", () => {
    cp.createTenant("acme");
    cp.createTenant("globex");
    expectCode(() => cp.createTenant("acme"), "tenant_exists");
    expect(cp.listTenants().map((t) => t.id)).toEqual(["acme", "globex"]);
  });

  test("a path-shaped id can never reach the filesystem", () => {
    expectCode(() => cp.tenantRoot("../escape"), "invalid_tenant_id");
    expect(existsSync(join(dir, "escape"))).toBe(false);
  });

  test("state survives reopening the control plane", () => {
    cp.createTenant("acme");
    const { token } = cp.createToken({ tenantId: "acme", room: "general" });
    closeAllDbs();
    const again = new ControlPlane(join(dir, "data"));
    expect(again.getTenant("acme")?.id).toBe("acme");
    expect(again.authenticate(token).ok).toBe(true);
  });
});

describe("tokens", () => {
  beforeEach(() => {
    cp.createTenant("acme");
  });

  test("format, and the record carries no secret", () => {
    const { token, record } = cp.createToken({ tenantId: "acme", room: "general", label: "ci" });
    expect(token).toMatch(/^hbr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ tenantId: "acme", room: "general", label: "ci", revokedAt: null, expiresAt: null });
    expect(JSON.stringify(record)).not.toContain(parts(token).secret);
    expect(tokenHandle(record.id)).toBe(`hbr_${record.id}_…`);
  });

  test("the plaintext secret is never written to disk — only its hash", () => {
    const { token } = cp.createToken({ tenantId: "acme", room: "general" });
    const { secret } = parts(token);
    closeAllDbs(); // flush WAL
    for (const f of readdirSync(join(dir, "data")).filter((n) => n.startsWith("control.db"))) {
      const bytes = readFileSync(join(dir, "data", f));
      expect(bytes.includes(Buffer.from(secret)), f).toBe(false);
    }
  });

  test("authenticate returns the token's tenant and its FIXED room", () => {
    const { token, record } = cp.createToken({ tenantId: "acme", room: "general", capabilities: ["read_skill"] });
    const r = cp.authenticate(token);
    expect(r).toEqual({
      ok: true,
      tenantId: "acme",
      room: "general",
      tokenId: record.id,
      capabilities: ["read_skill"],
      adminAllowed: false,
    });
  });

  test("every failure mode is refused, each with its own internal reason", () => {
    const { token, record } = cp.createToken({ tenantId: "acme", room: "general" });
    const { id, secret } = parts(token);

    expect(cp.authenticate("")).toEqual({ ok: false, reason: "malformed" });
    expect(cp.authenticate("Bearer " + token)).toEqual({ ok: false, reason: "malformed" });
    expect(cp.authenticate(`hbr_${id}_${secret.slice(0, -1)}`)).toEqual({ ok: false, reason: "malformed" });
    expect(cp.authenticate(`hbr_${"0".repeat(12)}_${secret}`)).toEqual({ ok: false, reason: "unknown_token" });
    const flipped = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    expect(cp.authenticate(`hbr_${id}_${flipped}`)).toEqual({ ok: false, reason: "bad_secret" });

    cp.revokeToken(record.id);
    expect(cp.authenticate(token)).toEqual({ ok: false, reason: "revoked" });
  });

  test("expiry is enforced against the supplied clock", () => {
    const { token, record } = cp.createToken({ tenantId: "acme", room: "general", ttlSeconds: 60 });
    expect(record.expiresAt).not.toBeNull();
    expect(cp.authenticate(token, record.createdAt + 30).ok).toBe(true);
    expect(cp.authenticate(token, record.createdAt + 61)).toEqual({ ok: false, reason: "expired" });
  });

  test("suspending a tenant stops all its tokens; resuming restores them", () => {
    const a = cp.createToken({ tenantId: "acme", room: "general" }).token;
    const b = cp.createToken({ tenantId: "acme", room: "general" }).token;
    cp.setTenantStatus("acme", "suspended");
    expect(cp.authenticate(a)).toEqual({ ok: false, reason: "tenant_suspended" });
    expect(cp.authenticate(b)).toEqual({ ok: false, reason: "tenant_suspended" });
    cp.setTenantStatus("acme", "active");
    expect(cp.authenticate(a).ok).toBe(true);
  });

  test("a token for tenant A cannot authenticate as tenant B", () => {
    cp.createTenant("globex");
    const a = cp.createToken({ tenantId: "acme", room: "general" }).token;
    const r = cp.authenticate(a);
    expect(r.ok && r.tenantId).toBe("acme");
  });

  test("revoke is idempotent and an unknown id is an error", () => {
    const { record } = cp.createToken({ tenantId: "acme", room: "general" });
    const first = cp.revokeToken(record.id).revokedAt;
    expect(first).not.toBeNull();
    expect(cp.revokeToken(record.id).revokedAt).toBe(first);
    expectCode(() => cp.revokeToken("deadbeef0000"), "no_such_token");
  });

  test("creation rejects hostile rooms, unknown capabilities, bad ttl, unknown tenants", () => {
    for (const room of ["", "..", "../finance", "a/b", ".x"]) {
      expectCode(() => cp.createToken({ tenantId: "acme", room }), "invalid_room");
    }
    expectCode(() => cp.createToken({ tenantId: "acme", room: "general", capabilities: ["read_skill", "root"] }), "invalid_capability");
    for (const ttl of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCode(() => cp.createToken({ tenantId: "acme", room: "general", ttlSeconds: ttl }), "invalid_ttl");
    }
    expectCode(() => cp.createToken({ tenantId: "nobody", room: "general" }), "no_such_tenant");
  });

  test("a room the tenant has not configured is refused (unless it is the default room)", () => {
    expectCode(() => cp.createToken({ tenantId: "acme", room: "legal" }), "unknown_room");
    expect(cp.createToken({ tenantId: "acme", room: "general" }).record.room).toBe("general");
    expect(cp.createToken({ tenantId: "acme", room: "legal", allowUnconfiguredRoom: true }).record.room).toBe("legal");
    const cfg = join(cp.tenantRoot("acme"), ".agent-env", "config.toml");
    writeFileSync(cfg, '[skills.rooms.legal]\nskills = []\n');
    expect(cp.createToken({ tenantId: "acme", room: "legal" }).record.room).toBe("legal");
  });

  test("`admin` must be explicitly allowed by the operator", () => {
    expectCode(() => cp.createToken({ tenantId: "acme", room: "general", capabilities: [Capability.ADMIN] }), "admin_not_allowed");
    const t = cp.createToken({ tenantId: "acme", room: "general", capabilities: [Capability.ADMIN], allowAdmin: true });
    expect(t.record.adminAllowed).toBe(true);
  });

  test("list, optionally per tenant", () => {
    cp.createTenant("globex");
    cp.createToken({ tenantId: "acme", room: "general" });
    cp.createToken({ tenantId: "globex", room: "general" });
    expect(cp.listTokens().length).toBe(2);
    expect(cp.listTokens("acme").map((t) => t.tenantId)).toEqual(["acme"]);
  });

  test("last_used_at is recorded, but not rewritten on every request", () => {
    const { token, record } = cp.createToken({ tenantId: "acme", room: "general" });
    cp.authenticate(token, record.createdAt + 5);
    const first = cp.listTokens("acme")[0]!.lastUsedAt;
    expect(first).toBe(record.createdAt + 5);
    cp.authenticate(token, record.createdAt + 10); // within the 60s granularity
    expect(cp.listTokens("acme")[0]!.lastUsedAt).toBe(first);
    cp.authenticate(token, record.createdAt + 100);
    expect(cp.listTokens("acme")[0]!.lastUsedAt).toBe(record.createdAt + 100);
  });
});

describe("createRoom", () => {
  beforeEach(() => {
    cp.createTenant("acme");
  });

  test("creates the room on disk and in config, so skill-install and token create both accept it", () => {
    expect(cp.createRoom("acme", "legal", { description: "Contracts and NDAs" })).toEqual({ created: true });
    const root = cp.tenantRoot("acme");
    const rules = readFileSync(join(root, "rooms", "legal", "room_rules.md"), "utf8");
    expect(rules).toContain("# legal");
    expect(rules).toContain("Contracts and NDAs");
    const env = cp.tenantEnvironment("acme");
    expect(env.config.hasRoom("legal")).toBe(true);
    expect(env.config.roomSkillSet("legal").size).toBe(0);
    expect(cp.createToken({ tenantId: "acme", room: "legal" }).record.room).toBe("legal");
  });

  test("is idempotent and never overwrites a room_rules.md someone wrote", () => {
    cp.createRoom("acme", "legal");
    writeFileSync(join(cp.tenantRoot("acme"), "rooms", "legal", "room_rules.md"), "# my own rules\n");
    expect(cp.createRoom("acme", "legal")).toEqual({ created: false });
    expect(readFileSync(join(cp.tenantRoot("acme"), "rooms", "legal", "room_rules.md"), "utf8")).toBe("# my own rules\n");
  });

  test("preserves what is already in the tenant's config", () => {
    cp.createRoom("acme", "legal");
    cp.createRoom("acme", "finance");
    const env = cp.tenantEnvironment("acme");
    expect(Object.keys(env.config.roomSkills).sort()).toEqual(["finance", "legal"]);
    expect(readFileSync(cp.tenantConfigPath("acme"), "utf8")).toContain("[paths]");
  });

  test("hostile names never reach the filesystem", () => {
    for (const room of ["", "..", "../escape", "a/b", ".hidden", "a b"]) {
      expectCode(() => cp.createRoom("acme", room), "invalid_room");
    }
    expect(existsSync(join(dir, "data", "tenants", "escape"))).toBe(false);
    expect(existsSync(join(cp.tenantRoot("acme"), "rooms", ".hidden"))).toBe(false);
  });

  test("a room name the config editor rejects (dots) is a clean error, and leaves no half-made room in config", () => {
    expectCode(() => cp.createRoom("acme", "a.b"), "invalid_room");
    expect(cp.tenantEnvironment("acme").config.hasRoom("a.b")).toBe(false);
  });

  test("an unknown tenant", () => {
    expectCode(() => cp.createRoom("nobody", "legal"), "no_such_tenant");
  });
});

describe("tenantEnvironment — no bleed between tenants or from the operator", () => {
  test("each tenant gets its own root, state dir, and skill pool", () => {
    cp.createTenant("acme");
    cp.createTenant("globex");
    const a = cp.tenantEnvironment("acme");
    const g = cp.tenantEnvironment("globex");
    expect(a.root).toBe(cp.tenantRoot("acme"));
    expect(g.root).toBe(cp.tenantRoot("globex"));
    expect(a.skillsDir).toBe(join(a.root, ".agents", "skills"));
    expect(a.stateDir).not.toBe(g.stateDir);
    expect(a.isolationDb).not.toBe(g.isolationDb);
    expect(a.sessionsDb).not.toBe(g.sessionsDb);
  });

  test("the OPERATOR's own ~/.agent-env/config.toml can never be inherited", () => {
    // `Environment.load()` / `Config.load(null)` fall back to the operator's
    // default config when it exists. The suite must not plant one in the real
    // home (os.homedir() is snapshotted at startup), so pin the MECHANISM
    // instead: a tenant's config is only ever loaded from an explicit path
    // inside its own root — `Config.load` is never called without one.
    const spy = spyOn(Config, "load");
    try {
      cp.createTenant("acme");
      const cfg = cp.tenantConfigPath("acme");
      cp.tenantEnvironment("acme");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toBe(cfg); // always the tenant's own file…

      writeFileSync(cfg, '[skills.rooms.legal]\nskills = []\n');
      utimesSync(cfg, new Date(), new Date(Date.now() + 5000));
      cp.tenantEnvironment("acme");
      expect(spy).toHaveBeenCalledTimes(2);
      for (const call of spy.mock.calls) expect(call[0]).toBe(cfg); // …never `Config.load(null)`
    } finally {
      spy.mockRestore();
    }
    const env = cp.tenantEnvironment("acme");
    expect(env.config.hasRoom("operator-only")).toBe(false);
  });

  test("a tenant's own config.toml is loaded, and edits apply without a restart", () => {
    cp.createTenant("acme");
    const cfg = join(cp.tenantRoot("acme"), ".agent-env", "config.toml");
    expect(cp.tenantEnvironment("acme").config.hasRoom("legal")).toBe(false);
    writeFileSync(cfg, '[skills.rooms.legal]\nskills = ["nda-review"]\n');
    utimesSync(cfg, new Date(), new Date(Date.now() + 5000)); // guarantee a new mtime
    const env = cp.tenantEnvironment("acme");
    expect(env.config.hasRoom("legal")).toBe(true);
    expect(env.configPath).toBe(cfg);
    expect(cp.tenantEnvironment("acme")).toBe(env); // cached while unchanged
  });

  test("a config that points state or skills OUTSIDE the tenant root is refused", () => {
    cp.createTenant("acme");
    const cfg = join(cp.tenantRoot("acme"), ".agent-env", "config.toml");
    writeFileSync(cfg, '[paths]\nskills_dir = "/etc"\n');
    expectCode(() => cp.tenantEnvironment("acme"), "config_escape");

    writeFileSync(cfg, `[paths]\nstate_dir = "${join(dir, "elsewhere")}"\n`);
    utimesSync(cfg, new Date(), new Date(Date.now() + 10_000));
    expectCode(() => cp.tenantEnvironment("acme"), "config_escape");
  });

  test("…including one that escapes through a symlink inside the tenant root", () => {
    cp.createTenant("acme");
    const outside = join(dir, "outside-pool");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(cp.tenantRoot("acme"), "pool-link"));
    writeFileSync(join(cp.tenantRoot("acme"), ".agent-env", "config.toml"), '[paths]\nskills_dir = "~/pool-link"\n');
    expectCode(() => cp.tenantEnvironment("acme"), "config_escape");
  });

  test("an unknown tenant has no environment", () => {
    expectCode(() => cp.tenantEnvironment("nobody"), "no_such_tenant");
  });
});

describe("evictTenant / closeDbsUnder", () => {
  test("closes only the named tenant's handles, and a later open works", () => {
    cp.createTenant("acme");
    cp.createTenant("globex");
    const init = (d: { exec(sql: string): void }) => d.exec("CREATE TABLE IF NOT EXISTS t (x)");
    const acmeDb = join(cp.tenantRoot("acme"), ".agent-env", "one.db");
    const globexDb = join(cp.tenantRoot("globex"), ".agent-env", "one.db");
    openDb(acmeDb, init);
    openDb(globexDb, init);
    const before = cachedDbCount();

    expect(cp.evictTenant("acme")).toBe(1);
    expect(cachedDbCount()).toBe(before - 1);
    expect(cp.evictTenant("acme")).toBe(0); // idempotent

    // the other tenant's handle is untouched and still usable
    openDb(globexDb, init).db.query("INSERT INTO t VALUES (1)").run();
    // and the evicted one reopens from disk
    openDb(acmeDb, init).db.query("INSERT INTO t VALUES (1)").run();
    expect(cachedDbCount()).toBe(before);
  });

  test("a directory is matched as a path prefix, not a string prefix (acme vs acme-corp)", () => {
    cp.createTenant("acme");
    cp.createTenant("acme-corp");
    const init = (d: { exec(sql: string): void }) => d.exec("CREATE TABLE IF NOT EXISTS t (x)");
    openDb(join(cp.tenantRoot("acme-corp"), ".agent-env", "one.db"), init);
    expect(closeDbsUnder(cp.tenantRoot("acme"))).toBe(0);
    expect(cp.evictTenant("acme-corp")).toBe(1);
  });
});

describe("Environment.lockDefault", () => {
  test("default() throws while locked, and is restored on unlock", () => {
    Environment.lockDefault("multi-tenant server");
    expect(() => Environment.default()).toThrow(/multi-tenant server/);
    Environment.unlockDefault();
    expect(() => Environment.default()).not.toThrow();
  });
});

describe("ping", () => {
  test("true while open", () => {
    expect(cp.ping()).toBe(true);
  });
});
