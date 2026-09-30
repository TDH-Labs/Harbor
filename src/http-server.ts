/**
 * http-server.ts — Harbor Server: the hypervisor behind an authenticated HTTP
 * transport (MCP "Streamable HTTP", POST + JSON responses, no SSE).
 *
 * The same `createMcpServer` that backs the stdio integration handles every
 * request; what this file adds is everything a network service needs that a
 * child process does not:
 *
 *   identity    bearer token → (tenant, room). The room is fixed by the token.
 *               Nothing the client sends — header, body, query — can change it.
 *   isolation   one Environment per tenant (tenants.ts). The process locks
 *               `Environment.default()`, so any code path that forgot to pass an
 *               explicit env fails loudly instead of touching the operator's home.
 *   sessions    `Mcp-Session-Id`, issued at `initialize`, bound to the token that
 *               made it (a session id alone is worthless), idle-expiring.
 *   limits      body size, per-token request rate, sessions per token.
 *   hygiene     Origin validation (spec MUST), no CORS, structured access log
 *               that never contains a token or a request body.
 *
 * Endpoints
 *   GET    /healthz   liveness (no auth)
 *   GET    /readyz    readiness: control plane reachable (no auth)
 *   POST   /mcp       one JSON-RPC message (auth) — batches are rejected, as in
 *                     protocol 2025-06-18
 *   DELETE /mcp       end the session named by `Mcp-Session-Id` (auth)
 *   GET    /mcp       405 — this server offers no server-initiated stream
 *
 * TLS is terminated by a reverse proxy (see docs/CLOUD.md). Sessions are held in
 * memory: a restart makes clients re-initialize, which the protocol defines (404).
 * Budgets are cooperative cost control here, not a hard tenant quota.
 */
import { randomBytes } from "node:crypto";

import { createMcpServer, MCP_PROTOCOL_VERSION, type JsonRpcRequest } from "../integrations/mcp-server.ts";
import { Environment } from "./env.ts";
import type { GateContext } from "./gate.ts";
import { TokenBucketLimiter, declaredLength, readBodyCapped } from "./http-util.ts";
import { AgentSession, createSession } from "./isolation.ts";
import { ControlPlane, TenantError, tokenHandle, type AuthResult } from "./tenants.ts";

export const DEFAULT_SERVER_PORT = 8787;
export const DEFAULT_SERVER_HOST = "127.0.0.1";
const SESSION_HEADER = "mcp-session-id";
/** Revisions accepted in `MCP-Protocol-Version` (absent ⇒ the spec's back-compat default). */
const ACCEPTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION, "2025-03-26"]);

export interface ServerOptions {
  /** Data directory holding `control.db` and `tenants/`. */
  dataDir: string;
  /** An existing control plane (tests); otherwise one is opened on `dataDir`. */
  controlPlane?: ControlPlane;
  host?: string;
  port?: number;
  /**
   * Origins allowed to call /mcp from a browser. Default none: a request that
   * carries an `Origin` not in this list is refused (MCP spec: servers MUST
   * validate Origin to stop DNS-rebinding). Non-browser clients send no Origin.
   */
  allowedOrigins?: string[];
  /** Requests per minute per token (default 120). */
  rateLimitPerMinute?: number;
  /** Largest accepted request body in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** A session idle this long is dropped (default 3600s). */
  sessionIdleSeconds?: number;
  /** Concurrent sessions allowed per token (default 32). */
  maxSessionsPerToken?: number;
  /** Access-log sink (default: one JSON object per line on stdout). */
  logger?: (entry: Record<string, unknown>) => void;
  /** Clock in ms (tests). */
  now?: () => number;
}

interface HttpSession {
  id: string;
  tenantId: string;
  tokenId: string;
  room: string;
  agent: AgentSession;
  lastSeen: number;
}

export interface ServerHandler {
  readonly controlPlane: ControlPlane;
  fetch(req: Request): Promise<Response>;
  /** Number of live MCP sessions (diagnostics / tests). */
  sessionCount(): number;
  /** Stop timers. Does not close the control plane's database. */
  close(): void;
}

export interface RunningServer extends ServerHandler {
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { jsonrpc: "2.0", id: null, error: { code, message } }, headers);
}

const UNAUTHORIZED = () =>
  json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="harbor"' });

/**
 * The capabilities a token-bound session gets: the room's configured
 * capabilities, capped by the token's own ceiling, with `admin` only when the
 * operator explicitly issued it. A room whose config lists `admin` does not
 * hand it to a network caller.
 */
export function sessionCapabilities(
  roomCapabilities: readonly string[],
  auth: Extract<AuthResult, { ok: true }>,
): string[] {
  let caps = roomCapabilities.filter((c) => c !== "admin");
  if (auth.capabilities) caps = caps.filter((c) => auth.capabilities!.includes(c));
  if (auth.adminAllowed && auth.capabilities?.includes("admin")) caps = [...caps, "admin"];
  return caps;
}

// ── handler ──────────────────────────────────────────────────────────────────

export function createServerHandler(options: ServerOptions): ServerHandler {
  const now = options.now ?? Date.now;
  const cp = options.controlPlane ?? new ControlPlane(options.dataDir);
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const idleMs = (options.sessionIdleSeconds ?? 3600) * 1000;
  const maxSessionsPerToken = options.maxSessionsPerToken ?? 32;
  const limiter = new TokenBucketLimiter(options.rateLimitPerMinute ?? 120, now);
  const log =
    options.logger ??
    ((entry: Record<string, unknown>) => {
      process.stdout.write(JSON.stringify(entry) + "\n");
    });

  // A multi-tenant process must never fall back to the operator's own home.
  Environment.lockDefault("Harbor Server is multi-tenant: every call must use an explicit tenant Environment");

  const sessions = new Map<string, HttpSession>();

  function sweepSessions(): void {
    const t = now();
    for (const [id, s] of sessions) if (t - s.lastSeen > idleMs) sessions.delete(id);
    limiter.sweep();
  }
  const sweeper = setInterval(sweepSessions, 60_000);
  sweeper.unref?.();

  function liveSession(id: string | null, auth: Extract<AuthResult, { ok: true }>): HttpSession | null {
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    if (now() - s.lastSeen > idleMs) {
      sessions.delete(id);
      return null;
    }
    // A session belongs to the token that opened it. Anyone else gets the same
    // answer as for an unknown id, so ids cannot be probed.
    if (s.tokenId !== auth.tokenId || s.tenantId !== auth.tenantId) return null;
    s.lastSeen = now();
    return s;
  }

  async function handleMcp(req: Request, note: (k: string, v: unknown) => void): Promise<Response> {
    // 1. Origin — a browser page must be explicitly allowed.
    const origin = req.headers.get("origin");
    if (origin !== null && !allowedOrigins.has(origin)) {
      note("deny", "origin");
      return json(403, { error: "forbidden_origin" });
    }

    // 2. Authentication.
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!bearer) {
      note("deny", "no_bearer");
      return UNAUTHORIZED();
    }
    const auth = cp.authenticate(bearer, now() / 1000);
    if (!auth.ok) {
      note("deny", auth.reason); // the operator learns why; the client only learns "no"
      return UNAUTHORIZED();
    }
    note("tenant", auth.tenantId);
    note("token", tokenHandle(auth.tokenId));

    // 3. Rate limit, per token.
    const taken = limiter.take(auth.tokenId);
    if (!taken.ok) {
      note("deny", "rate_limited");
      return json(429, { error: "rate_limited" }, { "retry-after": String(taken.retryAfterSec) });
    }

    // 4. Tenant environment (a broken tenant config is the operator's problem, not a 500 leak).
    let env: Environment;
    try {
      env = cp.tenantEnvironment(auth.tenantId);
    } catch (err) {
      note("error", err instanceof TenantError ? err.code : "tenant_environment");
      return json(503, { error: "tenant_unavailable" });
    }

    if (req.method === "DELETE") {
      const sid = req.headers.get(SESSION_HEADER);
      const s = liveSession(sid, auth);
      if (!s) return json(404, { error: "unknown_session" });
      sessions.delete(s.id);
      note("session", s.id.slice(0, 8));
      return new Response(null, { status: 204 });
    }

    // 5. Request shape.
    const ctype = req.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(ctype)) {
      return json(415, { error: "content_type_must_be_application_json" });
    }
    const version = req.headers.get("mcp-protocol-version");
    if (version !== null && !ACCEPTED_PROTOCOL_VERSIONS.has(version)) {
      return json(400, { error: "unsupported_protocol_version", supported: [...ACCEPTED_PROTOCOL_VERSIONS] });
    }
    const declared = declaredLength(req.headers);
    if (declared !== null && declared > maxBody) return json(413, { error: "body_too_large" });
    const raw = await readBodyCapped(req.body, maxBody);
    if (raw === null) return json(413, { error: "body_too_large" });

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return rpcError(400, -32700, "parse error");
    }
    if (message === null || typeof message !== "object") return rpcError(400, -32600, "invalid request");
    if (Array.isArray(message)) return rpcError(400, -32600, "batching is not supported");
    const request = message as JsonRpcRequest;

    // A client's reply to a server request, or a bare notification: accepted, no body.
    const isResponse = request.method === undefined && ("result" in request || "error" in request);
    if (isResponse) return new Response(null, { status: 202 });

    // 6. Session.
    const headers: Record<string, string> = {};
    let session: HttpSession | null;
    if (request.method === "initialize") {
      const open = [...sessions.values()].filter((s) => s.tokenId === auth.tokenId).length;
      if (open >= maxSessionsPerToken) {
        note("deny", "too_many_sessions");
        return json(429, { error: "too_many_sessions" }, { "retry-after": "30" });
      }
      const id = randomBytes(16).toString("hex");
      const caps = sessionCapabilities(env.config.roomCapabilities(auth.room), auth);
      const agent = createSession({ room: auth.room, capabilities: caps, env, sessionId: id });
      session = { id, tenantId: auth.tenantId, tokenId: auth.tokenId, room: auth.room, agent, lastSeen: now() };
      sessions.set(id, session);
      headers["mcp-session-id"] = id;
      note("session", id.slice(0, 8));
    } else {
      const sid = req.headers.get(SESSION_HEADER);
      if (sid === null) return json(400, { error: "missing_mcp_session_id" });
      session = liveSession(sid, auth);
      if (!session) return json(404, { error: "unknown_session" }); // client must re-initialize
      note("session", session.id.slice(0, 8));
    }

    // 7. Dispatch through the SAME server the stdio transport uses, with the
    // context fixed by the token — never resolved from anything the client sent.
    const ctx: GateContext = { env, session: session.agent };
    const server = createMcpServer({ env, resolveContext: () => ctx });
    const response = await server.handle(request);
    if (response === null) return new Response(null, { status: 202, headers });
    return json(200, response, headers);
  }

  async function route(req: Request, note: (k: string, v: unknown) => void): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/healthz":
        return req.method === "GET" || req.method === "HEAD"
          ? json(200, { status: "ok" })
          : json(405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      case "/readyz":
        if (req.method !== "GET" && req.method !== "HEAD") {
          return json(405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
        }
        return cp.ping() ? json(200, { status: "ready" }) : json(503, { status: "unavailable" });
      case "/mcp":
        if (req.method === "POST" || req.method === "DELETE") return handleMcp(req, note);
        return json(405, { error: "method_not_allowed" }, { allow: "POST, DELETE" });
      default:
        return json(404, { error: "not_found" });
    }
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const started = now();
    const fields: Record<string, unknown> = {};
    const note = (k: string, v: unknown) => {
      fields[k] = v;
    };
    let res: Response;
    try {
      res = await route(req, note);
    } catch (err) {
      // Never leak internals to the client; the operator gets the message.
      note("error", err instanceof Error ? err.message : String(err));
      res = json(500, { error: "internal_error" });
    }
    res.headers.set("x-content-type-options", "nosniff");
    res.headers.set("cache-control", "no-store");
    log({
      ts: new Date(started).toISOString(),
      event: "request",
      method: req.method,
      path: new URL(req.url).pathname,
      status: res.status,
      ms: now() - started,
      ...fields,
    });
    return res;
  }

  return {
    controlPlane: cp,
    fetch: fetchHandler,
    sessionCount: () => sessions.size,
    close() {
      clearInterval(sweeper);
      sessions.clear();
    },
  };
}

/** How long {@link RunningServer.stop} waits for in-flight requests before closing them. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

/**
 * Bind the handler to a port. Throws if the address is unavailable.
 *
 * `stop()` drains, in this order: (1) every NEW request — including one arriving
 * on a pooled keep-alive connection — gets 503 + `Connection: close`, and
 * `/readyz` fails so an orchestrator stops routing here (`/healthz` stays 200 so
 * a liveness probe does not kill the process mid-drain); (2) requests already
 * running finish, up to `graceMs`; (3) the listener and every remaining
 * connection are closed. That is the behavior a rolling deploy needs.
 *
 * The listener deliberately stays open during (1)-(2): in Bun, `stop(false)`
 * followed by `stop(true)` does NOT close pooled connections (the second call is
 * a no-op), so a single final `stop(true)` is the only reliable close.
 */
export function startServer(options: ServerOptions & { graceMs?: number }): RunningServer {
  const handler = createServerHandler(options);
  const host = options.host ?? DEFAULT_SERVER_HOST;
  let inflight = 0;
  let draining = false;

  const server = Bun.serve({
    hostname: host,
    port: options.port ?? DEFAULT_SERVER_PORT,
    // Bun rejects an oversized body before it reaches us; the handler re-checks.
    maxRequestBodySize: (options.maxBodyBytes ?? 1024 * 1024) + 4096,
    async fetch(req) {
      if (draining && new URL(req.url).pathname !== "/healthz") {
        return new Response(JSON.stringify({ error: "shutting_down" }), {
          status: 503,
          headers: { "content-type": "application/json", connection: "close", "retry-after": "5" },
        });
      }
      inflight++;
      try {
        return await handler.fetch(req);
      } finally {
        inflight--;
      }
    },
  });

  return {
    ...handler,
    host,
    port: server.port ?? options.port ?? DEFAULT_SERVER_PORT,
    async stop() {
      draining = true;
      const deadline = Date.now() + (options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
      while (inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      handler.close();
      await server.stop(true); // closes the listener and every remaining connection
    },
  };
}
