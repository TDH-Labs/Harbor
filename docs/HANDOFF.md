# Harbor — handoff

Written at the merge of PR #1 (`8c91359` on `main`, package version 1.2.0). Read this first, then
`docs/CLOUD.md` (operator guide and security model) and `docs/PLAN_cloud-ready.md` (audit, decisions D1–D16,
what was verified and how, what was not).

## 1. Where things stand

| | |
|---|---|
| `main` | `8c91359`, the merge of PR #1 (21 commits). CI green on the head commit: tests + typecheck, de-personalization gate. |
| Tests | 1170 across 56 files, `tsc` clean. CI runs the **latest Bun** (1.4.2 when last checked); develop on the same version. |
| Harbor Core (stdio, one operator) | Behaviour unchanged except the items in section 9. |
| Harbor Server (`harbor serve`) | New. Multi-tenant authenticated HTTP MCP. Built, tested in-process and against a real process, **never run in Docker**. |
| Not released | Nothing publishes automatically. There is no release workflow; the version was bumped by hand. |

## 2. Do these first

1. **Run the container check.** `bash scripts/smoke.sh docker` on a machine with Docker (OrbStack works; it provides
   `docker compose`). It has never been run. Needs port 8787 free; uses compose project `harbor-smoke` and image tag
   `harbor-smoke:test`, and removes what it created. Expect to fix things; treat its first run as the first verification of
   the image.
2. **Decide the license.** `LICENSE` and `package.json` say MIT (and GitHub shows MIT; the repo is public and has been
   MIT since 2026-06-20). The README footer says "All rights reserved". Three holder names appear. See section 8.
3. **Choose how Son of Anton is reached** (section 6). Nothing there is built yet beyond the client library.
4. **Get an independent human security review** before exposing Harbor Server to the internet or to more than one
   customer. The reviews so far were done by agents (the author, then three independent reviewer agents).

## 3. What Harbor is

A control plane for AI agents: **rooms** (each with a skill allowlist and capabilities), **capability gating**, **token
budgets**, an **audit log** (SQLite), a **skill pool** with progressive disclosure, exposed to agents over MCP.
One codebase, two shapes:

| | Core | Server |
|---|---|---|
| Transport | stdio (`harbor mcp-server`) | HTTPS (`POST /mcp`, bearer token) |
| Identity | launching environment (`AGENT_ENV_ROOM`) | token bound to (tenant, room, person) |
| State | `~/.agent-env`, `~/rooms`, `~/.agents/skills` | `<data-dir>/control.db` + `<data-dir>/tenants/<id>/` |

Runtime: Bun + TypeScript. CLI is citty; dashboard is hono; config is TOML via `smol-toml`.

## 4. Map of the code (what this work added or changed)

| File | Responsibility |
|---|---|
| `src/http-server.ts` | The server: auth, session binding, delegation header, rate/session/body limits, drain. |
| `src/tenants.ts` | `ControlPlane`: tenants, tokens (SHA-256 stored), principals, grants, usage/quotas, `control.db` migrations. |
| `src/sensitivity.ts`, `src/labels.ts` | Label rules (pure) and `harbor label` editing/report. |
| `src/gate.ts`, `src/isolation.ts` | Gate, sessions, `roomSkillAllowed` (strict rooms), ceilings, `filterVisible`, audit read. |
| `integrations/mcp-server.ts`, `integrations/pi.ts` | The tools; both apply ceilings to list/search/route. |
| `src/sandbox.ts`, `src/path-safety.ts` | Realpath-based room containment. |
| `src/system-one.ts`, `src/turn-sieve.ts` | Optional router client (untrusted advice) and `route_skills`. |
| `src/guard.ts` | Pre-sync secret scanner. |
| `src/proposals.ts`, `src/printable.ts` | Digest-bound approval of skills from a shared folder; safe printing of untrusted text. |
| `integrations/delegate-client.ts` | Reference client for a house agent acting for a named person. |
| `src/service.ts` | launchd / systemd unit generation. |
| `src/dashboard.ts` | Health dashboard (escaping, CSP, token auth, Host/Origin guards). |
| `src/cli.ts` | New commands: `serve`, `tenant`, `token`, `principal`, `label`, `proposal`, `guard`, `service`. |
| `Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile.example`, `scripts/smoke.sh` | Packaging and the end-to-end check. |

## 5. Security model in one screen

- A Server token is bound to one room and (optionally) one person; the client cannot choose either. On a server an
  **empty room grants nothing**, including the unconfigured default room `general`.
- **Sensitivity labels** `public < internal < restricted`: a room default plus per-skill overrides, in the operator's
  config only (never in `SKILL.md`). A token with `--max-sensitivity` is never handed a skill above it, **nor an unlabeled
  one**; an invalid label counts as `restricted`; hidden skills are also absent from list/search/route. The agent sees the
  same words as for an out-of-room skill; the audit row has the real reason.
- **People:** tokens name a person; audit rows carry them; suspend/resume/revoke per person; daily delivery is **recorded
  per person** across all credentials. **A limit belongs to the credential that carries it** — a credential with no limit is
  unlimited. Put a limit on every token and every grant.
- **Delegation:** a `--delegate` token has no room/person/ceiling/quota of its own. Each request names the person
  (`Harbor-On-Behalf-Of`); that person's **grant** (room, clearance, quotas) decides everything and is re-read every
  request. A changed room/clearance/capability set ends the open session (404, client re-initializes).
- **Audit visibility:** on a server, `audit_recent` needs the `audit_read` capability (no room has it by default) and shows only
  that session's rows; `list_rooms` shows only the session's own room.
- **Shared folders:** `harbor guard` before sync; `harbor proposal` to install a skill only if it is byte-for-byte what the
  owner reviewed. Nothing installs from a shared folder by itself and no MCP tool can install.
- **Hard limit, stated in the docs:** access can be controlled at **delivery**, never at **use** by a person's own agent.
  Anything a bring-your-own agent must not ingest must never be delivered to that person.
- **Harbor cannot verify that a house agent named the right person.** It bounds the damage to that person's grant.

## 6. Son of Anton over MCP for users' own chat bots (decided, not built)

The requirement: a user's own bot (Muse, Dot, Grok, …) reaches Son of Anton (SoA) over MCP. This resolves the open
question of how SoA learns who is asking: **from the credential the user's bot presents to SoA's MCP endpoint, never from
chat text.**

```
user's bot --MCP (per-user bearer token)--> SoA MCP front door --delegate token + Harbor-On-Behalf-Of--> Harbor Server
```

- **Built:** the second hop. `integrations/delegate-client.ts` (`VerifiedIdentity` → `IdentityMap` → per-person Harbor
  session, typed errors, token never in errors/logs).
- **Not built:** the first hop (the SoA MCP front door: one token per user → `VerifiedIdentity.authenticated("mcp", …)`),
  and SoA's own logic (not in this repo). A reference front door with a pluggable `answer(person, question, harborSession)`
  callback would keep LLM code out of this repo while getting identity and authorization right.
- **Rule to bake in:** a person's SoA grant clearance must be **≤ the ceiling of their own bot's token**. The answer goes to
  the same bot; if the grant is higher, asking SoA becomes a side door around the ceiling.
- **Unverified:** whether Muse, Dot or Grok can connect to a remote MCP server with a bearer header. Check before
  designing around them.

## 7. Verification status (be careful what you rely on)

| Claim | Status |
|---|---|
| Unit/integration behaviour | 1170 tests pass locally and in CI, on Bun 1.3.11 and 1.4.2, including CI's exact file order. |
| Enforcement actually enforced | ~150 deliberate breakages by the author (each made a named test fail) plus 64 by an independent auditor; all surviving ones were then covered. **No mutation tool is in the repo**: the runners were ad hoc scripts in a scratch directory and were not kept. |
| Real process | `scripts/smoke.sh local`, 29 checks, re-verified to **fail** when the room gate or the sensitivity gate is broken. |
| Independent review | Three reviewer agents (authz/isolation, input/deploy, claims-vs-tests) found real defects in the author's code; all fixed. Not a human review. |
| Docker image | **Never built or run.** |
| Drive download restriction vs desktop offline copies | **Not checked.** Canary procedure in `docs/CLOUD.md`. |
| MCP client snippets (Claude Code, Cursor) in `docs/CLOUD.md` | Shapes only, not tested against those clients. |
| Load / soak / backup-restore | Not done. |

## 8. The license question

Facts: public repo, GitHub shows MIT, `LICENSE` (MIT, "Harbor contributors") since 2026-06-20, `package.json` MIT, README
footer "Copyright © 2026 TDH Labs / Vibherpunk. All rights reserved." MIT grants already taken generally cannot be
revoked. If a hosted offering is planned, MIT permits anyone to run a competing one. Options: stay MIT; AGPL-3.0; a
source-available license (BSL/FSL); or proprietary going forward (past versions stay MIT). Relicensing needs every
contributor's rights sorted (two human identities and AI-written commits). AI-generated code may have weaker copyright
protection (human authorship requirement). Not legal advice; involve counsel. Whichever is chosen, make `LICENSE`, README
and `package.json` agree.

## 9. Updating an existing Core install (what changes for a single operator)

No `control.db` exists in Core, so nothing migrates. Changes you may notice:

- `skill-install` now **refuses a source directory containing a symlink** (it used to copy the link into the pool).
- Room containment for file/data access and `spawn --confine` is **realpath-based**: a symlink that used to pass as "inside
  the room" is now denied.
- New tool `route_skills` (agents see it on reconnect); System One default endpoint is `http://127.0.0.1:8150` and port 8000
  is refused.
- `harbor dashboard` bound beyond loopback requires `HARBOR_DASHBOARD_TOKEN` (≥ 16 characters).
- `harbor guard`, `label`, `proposal`, `tenant`, `token`, `principal`, `serve`, `service` are new commands.

Procedure (untested against a real home directory; the tests never touch one):
back up `~/.agent-env`, check out the new code, `bun install && bun run build`, then `harbor check` (read-only health check).
Roll back by checking out the previous commit and restoring the backup.

## 10. Operating Harbor Server (from `docs/CLOUD.md`; all commands take `--data-dir` or `HARBOR_DATA_DIR`)

```bash
harbor tenant create acme
harbor tenant add-room acme --room legal
harbor skill-install ./nda-review --room legal --config <data>/tenants/acme/.agent-env/config.toml
harbor label set --skill nda-review --tier internal --config <same config>
harbor token create --tenant acme --room legal --principal kim@example.com \
    --max-sensitivity internal --daily-token-quota 20000 --daily-read-quota 15
harbor token create --tenant acme --delegate --label son-of-anton
harbor principal grant kim@example.com --tenant acme --room legal --clearance internal --daily-read-quota 15
harbor principal list|suspend|resume|revoke|grants ...
harbor proposal list|show|approve ...        # skills from a shared folder, by digest
harbor guard <folder> [--strict]             # run before every sync
harbor serve --host 127.0.0.1 --port 8787    # put a TLS proxy in front (Caddy example included)
```

State: `control.db` (tenants, hashed tokens, principals, grants, usage) and `tenants/<id>/` (that tenant's config, skill pool,
audit and budget databases). A token's secret is shown once and cannot be recovered. A tenant's config edits apply on the next
request (the environment cache keys on the file's mtime). Backup and restore have not been exercised.

## 11. Open work, in priority order

**Before real users**
1. Run `scripts/smoke.sh docker` and fix what it finds.
2. License decision (section 8).
3. SoA MCP front door and its identity mapping (section 6), plus a decision on who issues and revokes per-user tokens.
4. Independent human security review.
5. Pin the Bun version in CI (it is `latest`, which already differed from local once).

**Next**
6. Person-level quota caps (today a limit belongs to a credential; a person with one unlimited credential is unlimited).
7. A real mutation-testing tool or a kept runner, so the "break it and see which test fails" discipline survives the author.
8. Harden the few timing-based tests (drain test sleeps, dashboard 25 ms sleeps, an 8 s timer in `cli-server.test.ts`).
9. Test the MCP client snippets against real clients; write the Muse/Dot/Grok connection notes once their MCP support is known.
10. Hosted-offering gaps: billing, tenant self-service, admin UI/API, metrics/alerts, backup/restore, secret rotation procedure.
11. `harbor dashboard --root` loads built-in defaults rather than the tenant's config (use `--config`); make `--root` honor a tenant root or remove the footgun.
12. Hidden-character detection does not cover look-alike letters (a Cyrillic `а` in a Latin word).

## 12. Lessons that cost time (so they do not cost it again)

- **Bun: `process.exitCode = undefined` does not reset the exit code.** A test helper that "restores" a saved `undefined` after a
  failing CLI command made CI exit 1 with 0 failures, only under CI's file order. Restore with `saved ?? 0`. The test preload
  (`src/test-setup.ts`) now fails a file that leaves a non-zero exit code, by name.
- **A test that pins a behaviour as "intended" is not a review of it.** The worst bug (default room readable by any server
  token) had a test asserting it was fine.
- **When mutation-testing, read which test failed**, not just that something failed: one "killed" verdict was an unrelated flaky
  test, and another real gap hid behind it.
- **Ordering and same-millisecond rows:** several tests assumed a list order (tokens created in the same millisecond) that SQLite does not promise.
- **Hidden characters in our own source** are the same attack we refuse in a skill. A test scans the repo for them; write
  regex escapes as `\uXXXX` text, never literal characters.
- Fixtures that look like credentials are assembled at runtime (push protection refuses realistic literals). Tests must never
  touch the real home directory.
- `docker compose` here was never available in the authoring sandbox; do not infer anything about the image from the tests.

## 13. Conventions used in this work

- Small commits with explanatory messages; a local gate before every push (`bunx tsc --noEmit`, `bun test` and its exit code, and
  CI's de-personalization grep), then CI is checked on GitHub rather than assumed.
- Behaviour that fails closed: unlabeled is refused under a ceiling, an invalid label is `restricted`, a bad stored ceiling is the
  lowest, unknown people and ungranted people get the same `403`.
- Every new enforcement point has a test that fails when the enforcement is removed.

## 14. Provenance

Built in a Claude Code session (https://claude.ai/code/session_01LpQ4WAPKp2PrNic8DWGABv). PR #1:
https://github.com/TDH-Labs/Harbor/pull/1.
