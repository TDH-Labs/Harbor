# PLAN — Making Harbor cloud-ready (and self-hostable)

Status: **finalized and implemented (Phases 1a–2c) on branch `claude/harbor-cloud-ready-udpgrk`.**
Section 9 records what shipped, where it deviated from this plan, and how each
claim was verified.
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
| G13 | In Core, a *configured* room with an empty `skills` list is **unrestricted** for `read_skill` (`roomSkillAllowed`: "empty ⇒ no restriction"). Removing a room's last skill lets that room read the whole pool — a cross-room read. Found while running the quickstart end to end, not by inspection. | `src/isolation.ts` `roomSkillAllowed` | High on a server | Phase 2b (`strictRoom` on server sessions; Core default unchanged, documented) |

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

## 9. What shipped

| Phase | Commit theme | Verified by |
|---|---|---|
| 1a | `src/sandbox.ts`: `realpath` containment; `checkFileAccess`/`checkDataAccess` use it; `enforceFileAccess`/`enforceDataAccess` (throwing, audited); `spawn({ confineToRoom })` | 56 tests over a dirty fixture (symlinks, `link/../x`, `..` room names, loops, NUL). The lexical `isPathWithin` is asserted to accept the same string the sandbox denies. |
| 1b | `src/system-one.ts`, Turn-Sieve hardening, `route_skills` (MCP + Pi), `[system_one]` config | A lying local daemon (foreign skills, junk tools, huge/redirecting/slow answers); reserved-port refusal proven by a server that must receive zero requests. |
| 1c | Dashboard: escaping, nonce CSP, token auth, Host/Origin guards, bind policy | The page's real script run against hostile data; mutation check (neutering `esc()` fails the tests); **real Chromium** against the old and new code — the old code executed an injected `onerror`, the new code does not. |
| 2a | `src/tenants.ts`: control plane, hashed tokens, per-tenant Environment, `Environment.lockDefault` | Secret never on disk (checked by scanning the DB and WAL bytes); config-escape by absolute path and by symlink; operator config never inherited (asserted on the mechanism, not by planting files in a real home). |
| 2b | `src/http-server.ts`, `serve`/`tenant`/`token`/`service` CLI, `src/service.ts` | Two tenants with identical room names; room fixed by token; admin never granted from config; session bound to token; rate/session/body limits; graceful drain with an in-flight request; real-process `serve` + SIGTERM; systemd directive-injection refused. |
| 2c | `Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile.example`, README, `docs/CLOUD.md` | The Dockerfile's layers replicated by hand (production-only install, no tests, unprivileged run) and the real `HEALTHCHECK` command executed; the compiled single binary serves MCP; the documented quickstart runs as an automated test. |

### Deviations from the plan above

- **Found by running the quickstart, not by inspection (G13).** Core treats a
  configured room with an empty skill list as unrestricted; on a server that is a
  cross-room read. Server sessions are now `strictRoom`. Core's default is
  unchanged and documented. Also from that run: `skill-install` needs the room to
  exist first, so `harbor tenant add-room` was added and the docs corrected.
- **Graceful shutdown.** The plan said "graceful shutdown". In Bun 1.3,
  `server.stop(false)` followed by `server.stop(true)` does **not** close pooled
  keep-alive connections (the second call is a no-op — verified directly), so the
  drain keeps the listener open, answers new work with 503, fails `/readyz`,
  waits for in-flight requests, and only then does one `stop(true)`.
- **Tenant config is seeded** with `paths.home = <tenant root>` so the ordinary
  CLI (`--config <tenant config>`) roots at the tenant instead of the operator's
  home. The server ignores `paths.home` and roots every tenant explicitly.
- **No `--token` flag on `harbor dashboard`.** An argv secret is visible to every
  local user in the process table; the token comes from `HARBOR_DASHBOARD_TOKEN`.
- Deterministic Turn-Sieve matching gained a **noise floor** (score ≥ 20) in
  addition to the cap, so one stray description word does not select a skill.

### Found by reviewing the diff adversarially (after the phases above)

Each was reproduced or measured, fixed, and pinned by a test that fails without
the fix (checked by removing the fix):

- **Tenant-steerable outbound requests (SSRF).** The Turn-Sieve honored
  `[system_one] url` from the session's own config. Harmless for a single-user
  install, but on a server a tenant-editable URL points the server's requests at
  any host. Server sessions now ignore it (`trustConfigSystemOneUrl: false`).
- **Unbounded SQLite handles.** `db.ts` caches connections for the process
  lifetime, so a server that has ever served N tenants holds descriptors for all
  N. Idle tenants (10 min) are now evicted (`closeDbsUnder`, `evictTenant`).
- **CPU stall from one request.** `matchSkillsDeterministically` is
  O(skills × tokens). A 1 MiB prompt against 400 skills held the thread for
  ~5.2 s (measured), 23 ms after bounding the prompt (8,000 chars), distinct
  tokens (256) and `searchSkills` queries (512 chars / 32 terms).
  *Correction:* my first measurement claimed the old code "did not finish in two
  minutes"; that was my own benchmark script building its input quadratically.
  The corrected figure is the ~5 s above.
- `close()` did not unlock `Environment.default()`.

### Not verified

- **The container image was not built.** No Docker daemon was available. Its
  layers and runtime were replicated and run by hand (see Phase 2c), and the
  Dockerfile and compose file were reviewed, but `docker build` / `docker compose
  up` has not been run. `read_only: true` and `cap_drop: [ALL]` in the compose
  file are the likeliest things to need adjustment. A CI job that builds the
  image is the right next step.
- **Client connection snippets** in `docs/CLOUD.md` (Claude Code, Cursor) are
  shapes, not tested against those clients.
- **System One itself.** Only its client contract was built and tested, against
  local fake daemons. Nothing was run against the real daemon.

## 10. Mixed agents, people, and shared files

Context: a team where some members bring their own agent and others use a
house agent on the operator's VPS, sharing files through a synced drive. The
requirement: permissioned access honored either way and never exceeded, and
people with their own agent must not be able to ingest sensitive information.

### The constraint that shapes everything

A person's own agent runs on their machine as them, so anything that person can
read, their agent can read. Access can therefore only be controlled **at
delivery** (who receives content, how much, how fast, with what trail), never at
**use**. "Not ingested" means "not delivered": restricted content must not be
in a folder they can open, nor served to their token. Stated in `CLOUD.md`.

The second, subtler risk is the house agent: broad access acting for a
low-clearance requester (a confused deputy), and lower-privilege people writing
into folders it reads (prompt injection; `proposals/` → skill install is a
privilege-escalation path).

### Decisions

| # | Decision | Why |
|---|---|---|
| D10 | **One collaboration folder** in the drive (`context/`, `inbox/`, `proposals/`). Skills and room rules are **not** synced. People reach skills through Harbor (own agent over a token, or by asking the house agent). | Skills are gated, quota'd and audited by Harbor; a synced folder is none of those, and every member's agent reads everything in it. Removes the skill export/apply/quarantine/conflict machinery from the drive design. |
| D11 | **Identity is a person, not just a token.** Tokens name a principal; audit rows carry it; suspend/revoke per person; quotas counted per person. | Attribution and offboarding must follow the human across tokens and sessions. |
| D12 | **Daily delivery quotas are per person, per UTC day, enforced at the tool, atomically.** | Per-session budgets are bypassed by opening sessions; the allowance has to be keyed by who, not by session. |
| D13 | **`harbor guard`** is the pre-sync check for the shared folder. `export-shared` is **deferred**. | Skills are not synced (D10), so there is nothing to export; the folder still needs a secret scan. |
| D14 | **Sensitivity labels** (`public < internal < restricted`): a room default plus a per-skill override, both in the operator's config; a token may carry a ceiling (`--max-sensitivity`). **A token with a ceiling is never handed an unlabeled skill**; a label that is present but not a tier counts as `restricted`. There is no label inside `SKILL.md`. | Decided with the operator: labeling is the price of keeping a bring-your-own agent from ingesting sensitive content, and "unlabeled ⇒ denied" is what makes forgetting to label safe. A label authored inside a skill would be chosen by the party a label must not trust. |

### Built

- `principal` on tokens; `agentId` on every server session and **every audit
  call site** (the MCP server, Pi integration and Turn-Sieve all omitted it, so
  tool-level rows had an empty `agent_id`); `harbor principal
  list|suspend|resume|revoke`.
- Per-person daily quotas (`--daily-token-quota`, `--daily-read-quota`) enforced
  in `read_skill`/`activate_skill` via a `DeliveryQuota` on the gate context;
  charged in one `BEGIN IMMEDIATE` transaction. A refusal carries no content and
  is audited.
- `harbor guard <dir>` with filename and content rules, entropy check, symlinks
  flagged not followed, oversized/binary/unreadable reported as skipped,
  `--files-from` confined to the root, and output that never contains the secret.
- `control.db` from the previous release is migrated in place.
- **Sensitivity labels and ceilings** (D14): `src/sensitivity.ts` (pure rules),
  `src/labels.ts` + `harbor label set|clear|list`, `tokens.max_sensitivity`
  (migrated in place) + `token create --max-sensitivity`. Enforced in the gate for
  `read_skill`/`activate_skill` and applied to `list_skills`, `search_skills` and
  `route_skills` (Core, Server and the Pi integration), so a hidden skill's name
  is not shown either. The agent gets the same words as for an out-of-room skill;
  the audit row has the real reason. A refused read is not charged to the quota.

### How it was verified

- Attribution, per-person accounting and tool enforcement were each broken on
  purpose (drop `agentId`; count per token; count per session; remove the check
  in `read_skill`) and the intended tests failed each time.
- The quota transaction: six racing **processes** × 40 attempts against a
  100-unit allowance admit exactly 100; with a deferred transaction instead of
  `IMMEDIATE` they crash. That test is why the charge is `IMMEDIATE`.
- Guard: every fake credential in the tests is assembled at runtime (a
  repository's push protection would refuse realistic literals). My first test
  generator was an LCG that emitted near-constant strings (entropy 0.18), so the
  "random" fixtures were far weaker than they looked; it was replaced and a test
  now asserts the fixtures are actually high-entropy.
- Self-scan: running the guard over this repository first produced six findings.
  None was a real credential (fake test fixtures, a lockfile integrity hash, and
  `secret = made.token.slice(...)` — code). Detection was tightened where real
  credentials differ (they do not spell "EXAMPLE"; they are not `camelCase`
  identifiers) and both sides are pinned by tests. It now flags only the two
  files literally named `secrets.*`, which is the blunt filename rule working as
  designed.
- Labels: 17 deliberate breakages of the enforcement (gate check removed; each
  of list/search/route unfiltered in the server and in Pi; invalid label read as
  unlabeled or as public; unlabeled admitted; ceiling comparison off by one;
  override losing to the room; the cross-room rule; a tampered database value read
  as "no ceiling"; ceiling not passed to the session or not validated; the agent
  shown the true reason; label editing skipping its pool/tier checks) were each
  caught by the tests. A migration test builds a control.db from before the column
  existed. I did not exercise this against a real Drive-synced setup.
- Drive: `copyRequiresWriterPermission` / the download restriction applies to
  readers and commenters, not editors, and is enforced on API download too. How
  it interacts with the desktop client's offline sync was **not** verified.

### Not built (needs a decision or is deliberately deferred)

- **On-behalf-of** for the house agent: open its session with the requester's
  entitlements (intersection, not the agent's own). Open: how does it learn who
  is asking, and does it stay on Harbor Core or move to Harbor Server?
- **Owner approval for skill installs** that originate from a shared folder.
- **Output-audience control** (a house agent posting restricted content where the
  audience is broader than the asker) — an application-layer policy Harbor
  cannot enforce.
