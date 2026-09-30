/**
 * tenants.ts — Multi-tenant control plane: tenants, bearer tokens, and the
 * per-tenant {@link Environment}.
 *
 * Harbor Core trusts its caller: identity is `AGENT_ENV_ROOM` /
 * `AGENT_ENV_SESSION` in the process environment, which the launching operator
 * controls. A network service cannot — the caller controls every byte it sends.
 * So in Server mode identity comes from a CREDENTIAL:
 *
 *     bearer token  →  (tenant, room, optional capability ceiling)
 *
 * and the room is FIXED by the token; a client cannot choose or change it.
 *
 * Layout, under one data directory:
 *
 *     <data>/control.db                     tenants + token hashes (SQLite)
 *     <data>/tenants/<tenant-id>/           that tenant's Environment root:
 *         .agent-env/  .agents/skills/  rooms/  workspace/  data/  archive/
 *
 * Each tenant therefore has its own skill pool, config, audit log, budgets and
 * session store — there is no shared table to leak across.
 *
 * Token hygiene:
 *  - `hbr_<id>_<secret>`; the secret is 256 random bits, shown ONCE at creation.
 *  - Only SHA-256(secret) is stored; the id is a public handle for list/revoke.
 *  - Comparison is constant-time, and an unknown id still costs a hash, so a
 *    caller cannot enumerate ids by timing.
 *  - Every failure is one opaque result for the client; the specific reason is
 *    for the operator's log only.
 *  - `admin` (the room-gate bypass) cannot be put on a token unless the operator
 *    passes `allowAdmin`, and is stripped from a session otherwise even if a
 *    room's config lists it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Database } from "bun:sqlite";

import { Config } from "./config.ts";
import { ConfigEditError, ensureRoomInConfig } from "./config-edit.ts";
import { closeDbsUnder, openDb } from "./db.ts";
import { Environment } from "./env.ts";
import { Capability } from "./isolation.ts";
import { isRealPathWithin, isValidRoomName } from "./sandbox.ts";

/** 3–40 chars, lowercase alphanumerics and hyphens, not starting/ending with a hyphen. */
export const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const TOKEN_PREFIX = "hbr_";
const TOKEN_RE = /^hbr_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
/** `last_used_at` is written at most this often per token (no write per request). */
const LAST_USED_GRANULARITY_S = 60;

export type TenantStatus = "active" | "suspended";

export type TenantErrorCode =
  | "invalid_tenant_id"
  | "tenant_exists"
  | "no_such_tenant"
  | "invalid_room"
  | "unknown_room"
  | "invalid_capability"
  | "admin_not_allowed"
  | "no_such_token"
  | "config_escape"
  | "invalid_ttl";

export class TenantError extends Error {
  readonly code: TenantErrorCode;
  constructor(code: TenantErrorCode, message: string) {
    super(message);
    this.name = "TenantError";
    this.code = code;
  }
}

export interface TenantRecord {
  id: string;
  status: TenantStatus;
  note: string;
  createdAt: number;
}

export interface TokenRecord {
  id: string;
  tenantId: string;
  room: string;
  label: string;
  /** Capability ceiling; null = whatever the room's config grants. */
  capabilities: string[] | null;
  adminAllowed: boolean;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface CreateTokenOptions {
  tenantId: string;
  room: string;
  label?: string;
  /** Lifetime in seconds; omit for a non-expiring token. */
  ttlSeconds?: number;
  /** Ceiling on the room's capabilities (must be known capability names). */
  capabilities?: string[];
  /** Permit `admin` in `capabilities`. Off by default. */
  allowAdmin?: boolean;
  /** Skip the "room must be configured" check (a room configured later). */
  allowUnconfiguredRoom?: boolean;
}

/** Why authentication failed — for the operator's log, never for the client. */
export type AuthFailure =
  | "malformed"
  | "unknown_token"
  | "bad_secret"
  | "revoked"
  | "expired"
  | "unknown_tenant"
  | "tenant_suspended";

export type AuthResult =
  | {
      ok: true;
      tenantId: string;
      room: string;
      tokenId: string;
      /** Capability ceiling from the token, or null. */
      capabilities: string[] | null;
      adminAllowed: boolean;
    }
  | { ok: false; reason: AuthFailure };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'active',
  note       TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  room          TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  secret_hash   TEXT NOT NULL,
  capabilities  TEXT,
  admin_allowed INTEGER NOT NULL DEFAULT 0,
  created_at    REAL NOT NULL,
  expires_at    REAL,
  revoked_at    REAL,
  last_used_at  REAL
);
CREATE INDEX IF NOT EXISTS idx_tokens_tenant ON tokens(tenant_id);
`;

const sha256 = (v: string): Buffer => createHash("sha256").update(v).digest();
const nowSec = (): number => Date.now() / 1000;

interface TenantRow {
  id: string;
  status: string;
  note: string;
  created_at: number;
}
interface TokenRow {
  id: string;
  tenant_id: string;
  room: string;
  label: string;
  secret_hash: string;
  capabilities: string | null;
  admin_allowed: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

const toTenant = (r: TenantRow): TenantRecord => ({
  id: r.id,
  status: r.status === "suspended" ? "suspended" : "active",
  note: r.note,
  createdAt: r.created_at,
});
const toToken = (r: TokenRow): TokenRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  room: r.room,
  label: r.label,
  capabilities: r.capabilities === null ? null : (JSON.parse(r.capabilities) as string[]),
  adminAllowed: r.admin_allowed === 1,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  lastUsedAt: r.last_used_at,
});

const KNOWN_CAPABILITIES = new Set<string>(Object.values(Capability));

/** Render a token's public handle (safe to log): `hbr_<id>_…`. */
export function tokenHandle(id: string): string {
  return `${TOKEN_PREFIX}${id}_…`;
}

interface CachedEnv {
  env: Environment;
  configMtimeMs: number;
}

/** The control plane for one data directory. */
export class ControlPlane {
  readonly dataDir: string;
  private readonly db: Database;
  private readonly envCache = new Map<string, CachedEnv>();

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.tenantsDir, { recursive: true });
    this.db = openDb(join(this.dataDir, "control.db"), (d) => {
      d.exec("PRAGMA busy_timeout = 5000");
      d.exec("PRAGMA journal_mode = WAL");
      d.exec("PRAGMA foreign_keys = ON");
    }).db;
    this.db.exec(SCHEMA);
  }

  get tenantsDir(): string {
    return join(this.dataDir, "tenants");
  }

  /** Cheap liveness probe for /readyz. */
  ping(): boolean {
    try {
      return (this.db.query("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
    } catch {
      return false;
    }
  }

  // ── Tenants ────────────────────────────────────────────────────────────────

  static isValidTenantId(id: string): boolean {
    return TENANT_ID_RE.test(id);
  }

  /** Where the tenant's `config.toml` lives (it may not exist yet for an unseeded tenant). */
  tenantConfigPath(id: string): string {
    return join(this.tenantRoot(id), ".agent-env", "config.toml");
  }

  /** The tenant's Environment root. Validates the id first: it becomes a path segment. */
  tenantRoot(id: string): string {
    if (!TENANT_ID_RE.test(id)) throw new TenantError("invalid_tenant_id", `invalid tenant id: ${JSON.stringify(id)}`);
    return join(this.tenantsDir, id);
  }

  createTenant(id: string, options: { note?: string } = {}): TenantRecord {
    const root = this.tenantRoot(id);
    if (this.getTenant(id)) throw new TenantError("tenant_exists", `tenant '${id}' already exists`);
    for (const sub of [".agent-env", ".agents/skills", "rooms", "workspace", "data", "archive"]) {
      mkdirSync(join(root, sub), { recursive: true });
    }
    // Seed the tenant's config so the ordinary CLI can manage it safely:
    // `harbor skill-install --config <this file> ...` roots at `paths.home`,
    // which would otherwise default to the OPERATOR's home directory. (The
    // server itself never reads `paths.home` — it roots every tenant explicitly.)
    // `wx`: never overwrite a config that is already there.
    try {
      writeFileSync(
        this.tenantConfigPath(id),
        `# Harbor tenant "${id}". Manage with: harbor <command> --config <this file>\n` +
          `[paths]\nhome = ${JSON.stringify(root)}\n`,
        { flag: "wx" },
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      this.db
        .query("INSERT INTO tenants (id, status, note, created_at) VALUES (?, 'active', ?, ?)")
        .run(id, options.note ?? "", nowSec());
    } catch (err) {
      // Lost a create/create race between two processes: the PRIMARY KEY caught it.
      if (this.getTenant(id)) throw new TenantError("tenant_exists", `tenant '${id}' already exists`);
      throw err;
    }
    return this.requireTenant(id);
  }

  /**
   * Create a room for a tenant: `rooms/<room>/room_rules.md` on disk and an
   * empty `[skills.rooms.<room>]` in the tenant's config. This is what the
   * existing `skill-install --room` requires to already exist, and what
   * `createToken` requires to be configured. Idempotent; never overwrites an
   * existing `room_rules.md`.
   *
   * The new room holds NO skills. On a server session that means "nothing is
   * readable" (see `strictRoom` in isolation.ts) until skills are installed.
   */
  createRoom(tenantId: string, room: string, options: { description?: string } = {}): { created: boolean } {
    this.requireTenant(tenantId);
    if (!isValidRoomName(room)) {
      throw new TenantError("invalid_room", `invalid room name: ${JSON.stringify(room)}`);
    }
    const root = this.tenantRoot(tenantId);
    const roomDir = join(root, "rooms", room);
    mkdirSync(roomDir, { recursive: true });
    let created = false;
    try {
      writeFileSync(
        join(roomDir, "room_rules.md"),
        `# ${room}\n\n${options.description ? `${options.description}\n\n` : ""}Rules for the ${room} room.\n`,
        { flag: "wx" },
      );
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      const env = new Environment(root, Config.load(this.tenantConfigPath(tenantId)), this.tenantConfigPath(tenantId));
      if (ensureRoomInConfig(env, room).changed) created = true;
    } catch (err) {
      if (err instanceof ConfigEditError) throw new TenantError("invalid_room", err.message);
      throw err;
    }
    this.envCache.delete(tenantId);
    return { created };
  }

  getTenant(id: string): TenantRecord | null {
    const row = this.db.query("SELECT * FROM tenants WHERE id = ?").get(id) as TenantRow | null;
    return row ? toTenant(row) : null;
  }

  private requireTenant(id: string): TenantRecord {
    const t = this.getTenant(id);
    if (!t) throw new TenantError("no_such_tenant", `no such tenant: ${JSON.stringify(id)}`);
    return t;
  }

  listTenants(): TenantRecord[] {
    return (this.db.query("SELECT * FROM tenants ORDER BY created_at, id").all() as TenantRow[]).map(toTenant);
  }

  /** Suspend or resume a tenant: every token it holds stops authenticating (or resumes). */
  setTenantStatus(id: string, status: TenantStatus): TenantRecord {
    this.requireTenant(id);
    this.db.query("UPDATE tenants SET status = ? WHERE id = ?").run(status, id);
    return this.requireTenant(id);
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /**
   * Mint a token. The returned `token` is the ONLY time the secret exists in
   * plaintext — it is not stored and cannot be recovered.
   */
  createToken(options: CreateTokenOptions): { token: string; record: TokenRecord } {
    this.requireTenant(options.tenantId);
    if (!isValidRoomName(options.room)) {
      throw new TenantError("invalid_room", `invalid room name: ${JSON.stringify(options.room)}`);
    }
    if (!options.allowUnconfiguredRoom) {
      const cfg = this.tenantEnvironment(options.tenantId).config;
      if (!cfg.hasRoom(options.room) && options.room !== cfg.skillDefaultRoom) {
        throw new TenantError(
          "unknown_room",
          `room '${options.room}' is not configured for tenant '${options.tenantId}' ` +
            `(configured: ${Object.keys(cfg.roomSkills).join(", ") || "none"}; default: ${cfg.skillDefaultRoom})`,
        );
      }
    }
    let capabilities: string[] | null = null;
    if (options.capabilities) {
      const unique = [...new Set(options.capabilities)];
      for (const c of unique) {
        if (!KNOWN_CAPABILITIES.has(c)) throw new TenantError("invalid_capability", `unknown capability: ${JSON.stringify(c)}`);
      }
      if (unique.includes(Capability.ADMIN) && !options.allowAdmin) {
        throw new TenantError("admin_not_allowed", "the 'admin' capability bypasses room gating; pass allowAdmin to grant it");
      }
      capabilities = unique;
    }
    if (options.ttlSeconds !== undefined && !(Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0)) {
      throw new TenantError("invalid_ttl", "ttlSeconds must be a positive number");
    }

    const id = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const now = nowSec();
    this.db
      .query(
        `INSERT INTO tokens (id, tenant_id, room, label, secret_hash, capabilities, admin_allowed, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        options.tenantId,
        options.room,
        options.label ?? "",
        sha256(secret).toString("hex"),
        capabilities === null ? null : JSON.stringify(capabilities),
        options.allowAdmin ? 1 : 0,
        now,
        options.ttlSeconds === undefined ? null : now + options.ttlSeconds,
      );
    const record = toToken(this.db.query("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow);
    return { token: `${TOKEN_PREFIX}${id}_${secret}`, record };
  }

  listTokens(tenantId?: string): TokenRecord[] {
    const rows = (
      tenantId === undefined
        ? this.db.query("SELECT * FROM tokens ORDER BY created_at, id").all()
        : this.db.query("SELECT * FROM tokens WHERE tenant_id = ? ORDER BY created_at, id").all(tenantId)
    ) as TokenRow[];
    return rows.map(toToken);
  }

  /** Revoke by id. Idempotent; a token that never existed is an error. */
  revokeToken(id: string): TokenRecord {
    const row = this.db.query("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow | null;
    if (!row) throw new TenantError("no_such_token", `no such token: ${JSON.stringify(id)}`);
    if (row.revoked_at === null) this.db.query("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(nowSec(), id);
    return toToken(this.db.query("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow);
  }

  /** Verify a presented bearer token. Never throws. */
  authenticate(bearer: string, now: number = nowSec()): AuthResult {
    const m = TOKEN_RE.exec(bearer);
    if (!m) return { ok: false, reason: "malformed" };
    const id = m[1] as string;
    const secret = m[2] as string;

    const row = this.db.query("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow | null;
    // Hash and compare even for an unknown id, so timing does not reveal which ids exist.
    const expected = row ? Buffer.from(row.secret_hash, "hex") : Buffer.alloc(32);
    const matches = timingSafeEqual(sha256(secret), expected);
    if (!row) return { ok: false, reason: "unknown_token" };
    if (!matches) return { ok: false, reason: "bad_secret" };
    if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (row.expires_at !== null && row.expires_at <= now) return { ok: false, reason: "expired" };

    const tenant = this.getTenant(row.tenant_id);
    if (!tenant) return { ok: false, reason: "unknown_tenant" };
    if (tenant.status !== "active") return { ok: false, reason: "tenant_suspended" };

    if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_GRANULARITY_S) {
      this.db.query("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now, id);
    }
    const rec = toToken(row);
    return {
      ok: true,
      tenantId: rec.tenantId,
      room: rec.room,
      tokenId: rec.id,
      capabilities: rec.capabilities,
      adminAllowed: rec.adminAllowed,
    };
  }

  // ── Per-tenant Environment ─────────────────────────────────────────────────

  /**
   * Forget a tenant's cached Environment and close its open database handles.
   * Called for idle tenants so a server with many tenants holds file
   * descriptors only for the ones in use. The next request reopens lazily.
   */
  evictTenant(id: string): number {
    this.envCache.delete(id);
    return closeDbsUnder(this.tenantRoot(id));
  }

  /**
   * The tenant's Environment, rooted at its own directory with its own
   * `config.toml` (or built-in defaults). Never falls back to the operator's
   * config: {@link Environment.load} with no argument would, which is exactly
   * the cross-tenant leak this method exists to prevent.
   *
   * Reloaded when the tenant's config file changes on disk, so operator edits
   * (`harbor skill-room-add --root <tenant root>`) apply without a restart.
   *
   * A config whose `paths.*` point OUTSIDE the tenant root (an absolute
   * `skills_dir = "/etc"`, or a symlink out) is refused: `Environment.resolve`
   * honors absolute paths, so an unvalidated tenant-editable config would be a
   * read primitive over the host.
   */
  tenantEnvironment(id: string): Environment {
    const root = this.tenantRoot(id);
    this.requireTenant(id);
    const cfgPath = this.tenantConfigPath(id);
    const mtime = existsSync(cfgPath) ? statSync(cfgPath).mtimeMs : 0;
    const cached = this.envCache.get(id);
    if (cached && cached.configMtimeMs === mtime) return cached.env;

    const config = mtime > 0 ? Config.load(cfgPath) : Config.defaults();
    const env = new Environment(root, config, mtime > 0 ? cfgPath : null);
    for (const [label, path] of [
      ["paths.skills_dir", env.skillsDir],
      ["paths.state_dir", env.stateDir],
    ] as const) {
      if (!isRealPathWithin(path, root)) {
        throw new TenantError("config_escape", `tenant '${id}': ${label} resolves outside the tenant root (${path})`);
      }
    }
    this.envCache.set(id, { env, configMtimeMs: mtime });
    return env;
  }
}
