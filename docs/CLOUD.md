# Harbor Server — cloud and self-hosted operation

Harbor comes in two shapes from one codebase:

| | **Harbor Core** | **Harbor Server** |
|---|---|---|
| Runs as | a stdio MCP server spawned by one agent, plus CLI | `harbor serve`, one long-running process |
| Who it serves | one operator on one machine | many tenants, each with their own agents |
| Identity | `AGENT_ENV_ROOM` / `AGENT_ENV_SESSION` in the environment | a **bearer token** bound to `(tenant, room)` |
| State | `~/.agent-env`, `~/rooms`, `~/.agents/skills` | one directory tree per tenant under a data dir |
| Transport | stdio | HTTPS (`POST /mcp`, MCP Streamable HTTP, protocol `2025-06-18`) |

You self-host Harbor Server by running it yourself. A hosted offering is the same
binary run by you for your customers. There is no separate cloud edition.

See [`PLAN_cloud-ready.md`](PLAN_cloud-ready.md) for the design decisions and the
audit that motivated them.

## Architecture

```
  agents (Claude Code, Cursor, …)
        │  HTTPS, Authorization: Bearer hbr_<id>_<secret>
        ▼
  reverse proxy  ── terminates TLS, per-IP flood protection
        │  HTTP (loopback / private network)
        ▼
  harbor serve ──────────────────────────────────────────────┐
   │  token → (tenant, room)      MCP session (Mcp-Session-Id) │
   │  rate limit · body cap · Origin check                     │
   ▼                                                           │
  per-tenant Environment  ── the same gate / budget / audit ───┘
   <data>/tenants/<id>/  .agent-env/ (config, audit, budgets)
                         .agents/skills/  rooms/  workspace/  data/
   <data>/control.db     tenants + token hashes

  optional sibling:  System One router  (127.0.0.1:8150)  — advice only
```

Every tenant has its own skill pool, config, audit log, budgets and sessions.
There is no shared table to leak across.

## Quickstart (Docker)

```bash
docker compose up -d                       # Harbor on 127.0.0.1:8787, data in a named volume

# -T: no pseudo-TTY, so a captured token has no stray carriage returns
harbor() { docker compose exec -T harbor bun src/cli.ts "$@"; }

harbor tenant create acme
harbor tenant add-room acme --room legal --description "Contracts and NDAs"
```

A room is a name plus a skill allowlist. `add-room` creates it empty; skills are
ordinary directories containing a `SKILL.md`. Install one with the existing
skill command, pointing `--config` at the tenant's config so it acts on that
tenant (and not on the machine's own home):

```bash
# skills live in ./skills on the host, mounted read-only at /skills in the container
# (docker-compose.yml). The container's root filesystem is read-only, so do not
# try to `docker cp` files into it.
harbor skill-install /skills/nda-review --room legal \
  --config /data/tenants/acme/.agent-env/config.toml

TOKEN=$(harbor token create --tenant acme --room legal --label "acme legal agent" --ttl-days 90)
# hbr_1a2b3c4d5e6f_…   ← the ONLY time the secret is shown (notes go to stderr)
```

The same sequence without Docker runs as an automated test
(`src/cli-server.test.ts`, "the documented quickstart works end to end"). The
Docker wrapper around it (the bind mount, `exec -T`) has **not** been run — no
Docker daemon was available when this was written.

Check it end to end (this is the request every MCP client makes first):

```bash
curl -s -i -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# HTTP/1.1 200 OK   mcp-session-id: …
```

Connect an agent. Client syntax changes between releases, so treat these as
shapes and check your client's docs for the current spelling:

```bash
# Claude Code
claude mcp add --transport http harbor https://harbor.example.com/mcp \
  --header "Authorization: Bearer $HARBOR_TOKEN"
```

```jsonc
// Clients that take a URL + headers in JSON (e.g. Cursor's mcp.json)
{ "mcpServers": { "harbor": {
    "url": "https://harbor.example.com/mcp",
    "headers": { "Authorization": "Bearer hbr_…" } } } }
```

The agent then has `route_skills`, `search_skills`, `list_skills`, `read_skill`,
`activate_skill`, `deactivate_skill`, `list_rooms`, `budget_status` and
`audit_recent`, all scoped to its token's tenant and room.

### With TLS

```bash
HARBOR_DOMAIN=harbor.example.com docker compose --profile tls up -d
```

runs Caddy in front (`deploy/Caddyfile.example`) and obtains certificates
automatically. Harbor's own port stays bound to loopback.

**Do not expose port 8787 directly.** Harbor speaks plain HTTP; a bearer token
sent over it can be read by anyone on the path.

## Without Docker

```bash
bun install --production
export HARBOR_DATA_DIR=/var/lib/harbor
bun src/cli.ts serve --host 127.0.0.1 --port 8787
```

Run it under a supervisor. `harbor service print` renders a definition and
prints how to activate it; it never installs or starts anything:

```bash
harbor service print --unit serve --target systemd \
  --harbor-bin /usr/local/bin/bun --harbor-prefix /opt/harbor/src/cli.ts \
  --data-dir /var/lib/harbor --port 8787 --write
```

Absolute program paths are required (launchd and systemd do not search your
`PATH`). `--unit watcher` and `--unit system-one` (see below) work the same way.

## Configuration

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `HARBOR_DATA_DIR` | `--data-dir` | `~/.harbor-server` (`/data` in the image) | Control plane + tenant trees. **Back this up.** |
| `HARBOR_HOST` | `--host` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address |
| `HARBOR_PORT` | `--port` | `8787` | Port (`0` = ephemeral) |
| `HARBOR_ALLOWED_ORIGINS` | `--allowed-origins` | none | Browser origins allowed to call `/mcp` (comma-separated). CLI and desktop agents send no `Origin` and are unaffected. |
| `HARBOR_RATE_LIMIT` | `--rate-limit` | `120` | Requests per minute per token |
| `HARBOR_SYSTEM_ONE_URL` | — | `http://127.0.0.1:8150` | Where the optional System One router lives |
| `HARBOR_SYSTEM_ONE_RESERVED_PORTS` | — | `8000` | Ports Harbor refuses to send turn text to |

Fixed in this release: request body limit 1 MiB, session idle expiry 1 hour, at
most 32 concurrent sessions per token, 10 s shutdown grace, 10 minute idle-tenant
eviction.

Per-tenant behavior lives in that tenant's `config.toml` (`skills.rooms.*`,
`capabilities`, `budget`, `[system_one]`). Edits apply to new requests without a
restart. A tenant whose config points its skill or state directory outside the
tenant root is refused (`503`), not served.

## Endpoints

| Method | Path | Auth | |
|---|---|---|---|
| `GET`/`HEAD` | `/healthz` | none | Liveness. Stays `200` while draining. |
| `GET`/`HEAD` | `/readyz` | none | Readiness: control plane reachable. `503` while draining. |
| `POST` | `/mcp` | bearer | One JSON-RPC message. `initialize` returns `Mcp-Session-Id`; send it on every later request. Batches are rejected (protocol `2025-06-18`). Notifications get `202`. |
| `DELETE` | `/mcp` | bearer | End the session named by `Mcp-Session-Id`. |
| `GET` | `/mcp` | — | `405`. No server-initiated stream is offered. |

Status codes worth knowing: `401` (any auth failure — the same body for all of
them, so a client cannot tell "unknown token" from "revoked"), `403` (Origin not
allowed), `404` (unknown/expired session: re-`initialize`), `413`, `415`, `429`
(rate limit or too many sessions; `Retry-After` is set), `503` (draining, or the
tenant's config is broken).

## Managing tenants and tokens

```bash
harbor tenant create <id>          # 3–40 chars: a-z, 0-9, '-'
harbor tenant list [--json]
harbor tenant suspend <id>         # every token of the tenant stops working immediately
harbor tenant resume <id>

harbor token create --tenant <id> --room <room> \
       [--label TEXT] [--ttl-days N] [--capabilities a,b] [--allow-admin]
harbor token list [--tenant <id>]  # handles and state only — never secrets
harbor token revoke <token-id>     # the 12 hex chars after hbr_
```

- The secret is **256 random bits shown once**. Only its SHA-256 is stored, so a
  leaked `control.db` does not leak usable tokens.
- The **room is fixed by the token.** A client cannot pick or change it.
- `--capabilities` is a **ceiling**: the session gets the room's configured
  capabilities intersected with it, never more.
- `admin` bypasses room gating. It is never granted to a network caller by a
  room's config, and a token can carry it only if you pass `--allow-admin`.
- Revoking a token or suspending a tenant cuts off its open sessions on their
  next request.

## Security model — what is and is not enforced

**Enforced by Harbor Server**

- Authentication on every `/mcp` request; identity from the credential, never
  from anything the client sends.
- Tenant isolation: separate Environment, SQLite files and skill pool per tenant;
  `Environment.default()` is locked in the process so an accidental fall-back to
  the operator's own home is an error, not a leak.
- Room gating, capability checks, token budgets and the audit log — the same
  `gate()` / `checkBudget()` / `audit` primitives Harbor Core uses.
- **Strict rooms.** In Harbor Core a configured room whose skill list is empty
  means "no restriction", which a single-user install relies on. On the server
  that would be a cross-room read (remove the last skill from `finance` and a
  `finance` token could `read_skill` anything in the pool), so server sessions
  treat a configured-but-empty room as granting nothing. `tenant add-room`
  therefore gives you a room that can read nothing until you install skills.
- Session binding: a session id is useless without the token that opened it.
- Symlink-safe room containment (`realpath`) for any file/data/`spawn` path that
  goes through Harbor's checks. The server itself exposes **no file or shell
  tools**.
- The access log (JSON lines on stdout) never contains a token, a request body
  or a full session id.
- **No tenant-steerable outbound requests.** The server ignores a tenant
  config's `[system_one] url`; only the operator's `HARBOR_SYSTEM_ONE_URL`
  applies. (A tenant-editable URL would let a tenant aim the server at any host.)
  Tenants have no write path to their config today; this keeps it safe if one is
  ever added.
- **Bounded inputs.** Prompts are cut at 8,000 characters and search queries at
  512 before any matching runs. Keyword matching is O(skills × terms); on a
  single-threaded server an unbounded 1 MiB prompt held the thread for about 5 s
  (measured against 400 skills) and now takes about 25 ms.
- **Idle tenants release resources.** After 10 minutes without a request a
  tenant's cached environment and open database handles are dropped and reopened
  on the next request, so file descriptors track active tenants, not every
  tenant ever served.

**Not enforced — be clear-eyed about these**

- This is **cooperative, tool-level enforcement**, not OS confinement. It
  governs what an agent can do *through Harbor*. Run the server as an
  unprivileged user in a container (as shipped) for the OS-level layer.
- **Budgets are cooperative cost control, not a hard tenant quota.** A client can
  open new sessions (bounded by the per-token session cap and rate limit). Hard
  quotas and billing are not implemented.
- **No per-IP protection for unauthenticated traffic.** The rate limit is per
  token. Put IP-level limiting at the proxy.
- **TLS is the proxy's job.**
- **Single node.** Sessions live in memory; a restart makes clients
  re-`initialize` (the protocol defines this). To run more than one replica you
  must route each client to one replica (sticky routing); a shared session store
  is not implemented.
- Not implemented: OAuth for remote connectors, a tenant-scoped dashboard,
  Postgres, syncing a local Harbor Core with a server. See
  [`PLAN_cloud-ready.md`](PLAN_cloud-ready.md) §8.

## System One (optional router)

`route_skills` asks a small classifier daemon which of a room's skills a task
needs, so an agent loads one to three instead of scanning hundreds. It is
optional: with no daemon Harbor uses deterministic keyword matching, and the
tool's answer says which one produced it.

- **The daemon is not part of this repository.** Harbor ships the client, the
  trust boundary, and `harbor service print --unit system-one --command "…"`.
- Default `http://127.0.0.1:8150`, route `POST /v1/route-skills`. Port **8000 is
  reserved** and refused.
- Its answer is treated as **untrusted advice**: skill names are intersected with
  the room's own skills (a daemon naming another room's skill gets it dropped and
  audited), tool names must already be recommended by a room skill, the reply is
  size-capped, and redirects are refused.
- **Cap:** 3 skills per turn, up to 5 only when the daemon flags the turn
  cross-domain. Prompt text cannot raise it.
- **Privacy:** the task text (first 8,000 characters) and the room's skill
  names/descriptions are sent to the daemon. Run it on loopback or a private
  network you control.

## Operations

- **Backups:** the whole data directory (`control.db` + `tenants/`). Stop the
  server or use SQLite's online backup for a consistent copy.
- **Upgrades:** stop (`SIGTERM` drains in-flight requests), replace, start. Open
  sessions are lost; clients re-initialize.
- **Logs:** one JSON object per request on stdout
  (`ts, method, path, status, ms, tenant, token, session`); human messages on
  stderr. Denials carry a `deny` reason (`bad_secret`, `revoked`, `expired`,
  `tenant_suspended`, `rate_limited`, …) that clients never see.
- **Health:** point liveness at `/healthz` and readiness at `/readyz`.
- **Dashboard:** `harbor dashboard --root <tenant root>` serves one tenant's
  view on loopback. It is not exposed by the server. If you bind it beyond
  loopback it refuses to start without `HARBOR_DASHBOARD_TOKEN` (≥ 16 chars).
