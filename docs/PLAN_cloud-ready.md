# PLAN — Making Harbor cloud-ready (and self-hostable)

Status: **finalized, implementation in progress on branch `claude/harbor-cloud-ready-udpgrk`.**
This is the finalized form of the handoff dossier that proposed Room Path
Sandboxing, System One routing on a dedicated port, and the Dynamic Turn-Sieve.
The dossier itself is not in this repository; its decisions are restated here
and checked against what the code actually does.

## 1. Goal

Ship one Harbor codebase in two shapes:

| Shape | Who runs it | Identity | State |
|-------|-------------|----------|-------|
| **Harbor Core** (self-hosted, local) | one operator, one machine | the operator (env vars) | `~/.agent-env`, `~/rooms`, `~/.agents/skills` |
| **Harbor Server** (self-hosted or hosted cloud) | an operator serving many tenants/agents | a bearer token bound to `(tenant, room)` | one Environment root per tenant under a data dir |

Harbor Core keeps working exactly as today. Harbor Server is the same
hypervisor (rooms, gate, budget, audit) behind an authenticated HTTP transport.

Before adding a cloud surface, Harbor has to be correct on the surface it
already claims. Section 2 is the audit; Section 5 fixes it first.

## 2. Audit: where Harbor does not yet work as intended

Every row was verified against the code, not the README.

| # | Finding | Evidence | Severity | Fixed in |
|---|---------|----------|----------|----------|
| G1 | Room containment is **lexical only**. A symlink inside a room, or `link/../x`, escapes the room while `isPathWithin` says "inside". Documented as a limitation, but the handoff requires `realpath` containment. | `src/path-safety.ts` (`resolve`, never `realpath`) | High | Phase 1a |
| G2 | `checkFileAccess` / `checkDataAccess` accept any `session.room` string. A room named `..` makes the "room root" the whole home. | `src/isolation.ts` (`join(base, "workspace", session.room)`) | High | Phase 1a |
| G3 | `spawn()` `allowedPaths` and `cwd` are metadata only; nothing pins a child to its room. | `src/spawn.ts` header + body | Medium | Phase 1a (opt-in `confineToRoom`) |
| G4 | The **Turn-Sieve is not wired to anything**. `routeSkillsForTurn` is exported and tested but no MCP tool, Pi tool, or CLI calls it. | `grep routeSkillsForTurn` — only `index.ts` and `skills.ts` | High (advertised feature does not run) | Phase 1b |
| G5 | The daemon's answer is trusted blindly: skill names it returns are not checked against the room's skills, so a compromised or misconfigured daemon can name another room's skills; tool names are passed through verbatim. | `src/skills.ts` `routeSkillsForTurn` | High (isolation bypass via routing) | Phase 1b |
| G6 | No cap on selected skills. The deterministic fallback returns **every** match, defeating the "1–3 skills" promise. | `matchSkillsDeterministically` | Medium | Phase 1b |
| G7 | System One default endpoint is `127.0.0.1:8000`, which collides with another local daemon on that port. | `skills.ts` default endpoint | Medium | Phase 1b |
| G8 | Dashboard renders API values with `innerHTML` and no escaping (room/skill/audit strings can carry markup) → stored XSS. No auth; an unauthenticated WebSocket streams hypervisor events; no Host/Origin check → DNS-rebinding / cross-site WebSocket reads from any web page. | `src/dashboard.ts` frontend + `startDashboard` | High | Phase 1c |
| G9 | README describes things that do not exist: `services/system_one/` (FastAPI), `harbor-compactor.py`, `harbor search_skills / activate_skill / list_rooms / budget_status / compact` CLI verbs, Docker compose for System One, a per-turn interceptor. | README vs tree | Medium (trust) | Phase 2c |
| G10 | Session identity comes only from `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION`. Fine for a local child process, unusable for a network service (the caller controls it). | `gate.ts`, `mcp-server.ts` `defaultContext` | Blocker for cloud | Phase 2a/2b |
| G11 | `Environment.load(null)` silently falls back to the *server operator's* `~/.agent-env/config.toml`, and `Environment.default()` is used by hypervisor primitives when no env is passed. In a multi-tenant process either would leak one tenant's (or the operator's) config into another's. | `env.ts`, `config.ts` `Config.load` | Blocker for cloud | Phase 2a (`lockDefault`, explicit per-tenant config) |
| G12 | The hypervisor event bus (`emitHypervisorEvent`) is process-global. Any shared dashboard would show every tenant's events. | `src/audit.ts` | Blocker for a shared dashboard | Deferred (Section 8); server does not expose it |

Also noted, not changed (owner's call): `README.md` says "All rights reserved"
while `LICENSE` is MIT.

## 3. Reference product: HQ (hqforwork.com) — second-hand

**Caveat.** Fetching hqforwork.com was blocked by this environment's network
policy, so nothing here is first-hand. It comes from search-result summaries and
should be re-checked against the site. To do that, allow the host in the cloud
environment's network settings and re-run the analysis.

What the summaries describe: **HQ Core** (company knowledge and process as
files the team owns), **HQ Cloud** (syncs and shares memory, skills, projects,
workers, policies, MCP connections, secrets and integrations to the right people
and agents), **HQ Agents** (persistent role-based agents living in Slack) and
**HQ MCP** (company memory/tools surfaced in the chat client the team already
uses).

Mapping to Harbor (an inference, not a claim about HQ's internals):

| HQ concept | Harbor today | Harbor after this plan |
|------------|--------------|------------------------|
| Core = files you own | rooms + skill pool on disk | unchanged (Harbor Core) |
| Cloud = share/sync with the right people/agents | none | Harbor Server: tenants, tokens, room-scoped access over HTTP |
| MCP into any chat client | stdio MCP server | + Streamable-HTTP MCP endpoint |
| Agents in Slack | none | **out of scope** (Section 8) |
| Sync Core ⇄ Cloud | none | **out of scope** (Section 8) |

Harbor's differentiator stays the split it already has: deterministic,
audited gating in-process, and a fast non-generative router (System One) that
keeps per-turn context small.

## 4. Decisions (finalized)

The dossier ended with two open questions. Both are answered here, plus the
decisions the implementation needed.

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **System One runs as a managed service** (launchd LaunchAgent on macOS, systemd unit on Linux, sibling container in Docker). Harbor ships a **generator** (`harbor service print`), not the daemon: the daemon lives outside this repository. It never auto-starts as a side effect of `harbor install`. | Answers open question 1 (yes). Keeps the daemon's lifecycle out of Harbor's blast radius; the Turn-Sieve already degrades to deterministic matching when it is down. |
| D2 | **Default skill cap is 3. It escalates to 5 only when System One flags the turn `crossDomain`.** The flag comes from the classifier's response, never from prompt text, and the deterministic fallback never escalates. Hard ceiling 5. | Answers open question 2 (yes, bounded). A prompt cannot talk its way to a larger context budget. |
| D3 | **System One default is `http://127.0.0.1:8150`.** Port 8000 is on a reserved list (`HARBOR_SYSTEM_ONE_RESERVED_PORTS`, default `8000`); an endpoint on a reserved port is refused and routing falls back to deterministic matching. | Keeps 8000 free for the robotics daemon; refuses to talk to the wrong service instead of sending it prompts. |
| D4 | **Room roots are `rooms/<room>` and `workspace/<room>`; containment is `realpath`-based and fails closed.** Room names are validated (`[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`). `data/<room>` keeps its own root. | Matches the dossier's `RoomPathSandbox` and keeps the existing `workspace/<room>` contract. |
| D5 | **Shell confinement is opt-in** (`spawn({ confineToRoom: true })`, `harbor spawn --confine`) and pins `cwd` inside the room. Harbor's MCP server still exposes **no file or shell tools**; anything added later must go through the sandbox. | Making it default would break every existing caller; adding a shell tool to a network service is not something to do speculatively. |
| D6 | **Cloud identity = bearer token → `(tenant, room)`.** Tokens are random 256-bit values, stored only as SHA-256 hashes, shown once, expiring and revocable. The room is fixed by the token; a client cannot choose it. `admin` is never grantable through a token by default. | G10. |
| D7 | **Tenancy = one Environment root per tenant** under `HARBOR_DATA_DIR/tenants/<id>`, SQLite per tenant, control-plane SQLite for tenants/tokens. `Environment.default()` is locked in server mode. | G11. Simple, auditable isolation; single node first. |
| D8 | **Transport = MCP Streamable HTTP, POST only, JSON responses, no SSE**, protocol `2025-06-18` (the revision the stdio server already implements). Origin validated, per-token rate limit, `Mcp-Session-Id` sessions with idle expiry. TLS is terminated by a reverse proxy. | Smallest spec-compliant surface. |
| D9 | The System One `/v1/decide` client (room assignment, model tier) is **not** implemented here. | Its request/response contract lives in a server file that is not in this repository; guessing it would be fiction. Tracked in Section 8. |

## 5. Implementation plan

Each phase is a separate commit with tests; the full suite, `tsc --noEmit`, and
the de-personalization gate must stay green at every commit.

### Phase 1 — make the existing surface correct (G1–G9)

**1a. Room path sandbox** — `src/sandbox.ts`
- `realpathLoose(path)`: walks segments, following symlinks at each step and
  applying `..` to the *resolved* path (POSIX semantics), so `link/../x` cannot
  escape; non-existent tails are appended lexically (so a not-yet-created file
  is checkable); symlink loops are bounded.
- `RoomPathSandbox`: `contains`, `resolve` (throws `RoomJailViolation`,
  message prefixed `HARBOR ROOM JAIL VIOLATION`), `resolveCwd`.
- `checkFileAccess` / `checkDataAccess` use it; new `enforceFileAccess` throws
  and audits (`room_jail_violation`).
- `spawn({ confineToRoom })`.
- *Acceptance*: a symlink to another room, `link/../other`, a room named `..`,
  an absolute path, and a NUL byte are all denied; a not-yet-existing file
  inside the room is allowed; every pre-existing isolation test still passes.
- *Known limits (documented in code)*: check-then-use races and hard links are
  not closed by path checks; this is cooperative, tool-level enforcement.

**1b. System One + Turn-Sieve** — `src/system-one.ts`, `src/skills.ts`
- Endpoint resolution (`HARBOR_SYSTEM_ONE_URL`, legacy
  `HARBOR_ROUTE_SKILLS_ENDPOINT`), reserved ports, timeout.
- Daemon output is **intersected with the room's available skills**; unknown
  names are dropped and counted; tools are accepted only if they appear in a
  selected skill's own frontmatter; response body size-capped.
- Cap 3 / escalate 5 (D2), applied to the daemon path **and** the
  deterministic fallback.
- Result gains `source`, `crossDomain`, `dropped`, `fallbackReason`.
- New MCP/Pi tool `route_skills(prompt)` gated as `search_skills`, room-scoped,
  audited. This is what wires G4.
- *Acceptance*: a daemon returning another room's skill yields nothing from that
  room; a port-8000 endpoint is refused; 6 matching skills yield 3 (5 with the
  flag); daemon down → deterministic with `source: "deterministic"`.

**1c. Dashboard** — `src/dashboard.ts`
- Escape every interpolated value in the frontend.
- Optional token (`--token` / `HARBOR_DASHBOARD_TOKEN`): bearer header or a
  one-time `?token=` that sets an `HttpOnly; SameSite=Strict` cookie; applies to
  the WebSocket too.
- `--host`; binding a non-loopback host without a token is refused.
- Host-header allowlist (DNS rebinding) and WebSocket Origin check.

### Phase 2 — the server (G10–G11)

**2a. Tenants + tokens** — `src/tenants.ts`
- Control-plane SQLite: `tenants`, `tokens`. Tenant id `[a-z0-9-]{3,40}`.
- `createToken` returns the plaintext once; `authenticate` returns
  `{ tenant, room, capabilities, tokenId }` or a typed failure; suspended
  tenants, expired and revoked tokens are refused.
- `Environment.lockDefault()` and `tenantEnvironment()` (explicit per-tenant
  `Config`, never the operator's).

**2b. HTTP MCP server + CLI** — `src/http-server.ts`, `src/service.ts`, `src/cli.ts`
- `POST /mcp`, `GET /healthz`, `GET /readyz`; JSON-RPC via the existing
  `createMcpServer` with a per-request, token-derived gate context.
- Sessions, rate limiting, body limit, Origin and protocol-version checks,
  structured access log without secrets, graceful shutdown.
- CLI: `harbor serve`, `harbor tenant create|list|suspend|resume`,
  `harbor token create|list|revoke`, `harbor service print`.

**2c. Packaging and truth**
- `Dockerfile`, `docker-compose.yml`, reverse-proxy example, systemd/launchd
  generators.
- README rewritten to describe only what exists; `docs/CLOUD.md` for operators.

## 6. Verification strategy

- Baseline before any change: `tsc --noEmit` clean, 638 tests passing.
- New behavior is tested against a **dirty fixture** where it matters
  (symlinks, hostile room names, a lying daemon), following
  `ROADMAP_reconcile-and-consistency.md`: tests assert the failure modes, not
  only the happy path.
- The HTTP server is exercised end to end over a real socket.
- CI's de-personalization grep must stay green (no home-directory paths in
  shipped source or docs).

## 7. Security posture (stated plainly)

Harbor remains **cooperative, tool-level enforcement**. The sandbox and gate
stop accidents, misconfiguration, and a misbehaving agent that uses Harbor's
tools; they do not confine a process that can open files directly. In Server
mode the enforcement boundary is stronger where it counts: identity comes from
a credential, not the environment, the process exposes no file or shell tools,
and each tenant's state lives under a separate root. Running the server under
an unprivileged user in a container (as shipped) is the OS-level layer; see
`SPEC_hardening.md` §3 for the longer-term pool-isolation work.

Budgets in Server mode are cooperative cost control, not a hard tenant quota.

## 8. Deferred / open

- **System One `/v1/decide` client** — needs the server's request/response
  contract (it is not in this repo). Everything else about System One routing
  is done against the `/v1/route-skills` shape the code already parses.
- **Hard per-tenant quotas, billing, Postgres / multi-node** — sessions are
  in-memory and SQLite is per node; horizontal scale needs a shared store or
  sticky routing.
- **Tenant-scoped dashboard** — needs tenant-filtered hypervisor events (G12).
- **OAuth for remote MCP connectors** — bearer tokens first.
- **Core ⇄ Cloud sync and Slack-resident agents** (HQ parity items) — not
  started; design after the server is proven.
- **Analysis of hqforwork.com from the source** — blocked by network policy.
- **`README.md` "All rights reserved" vs MIT `LICENSE`** — owner decision.
