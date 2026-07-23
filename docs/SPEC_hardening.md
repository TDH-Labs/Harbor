# SPEC — Hardening: approval gate, pool isolation, secrets

Status: **accepted, phased build**. Written 2026-07-23, after an audit of every
`harbor install --for` target turned up a live isolation bypass (fixed in
`47e12ff`) and plaintext bearer tokens in three agent configs.

This spec covers three accepted changes. They are deliberately ordered by
**blast radius**, not by value: the cheapest and least breaking first, the one
that can lock an operator out of their own skill pool last.

| # | Change | Breaking? | Effort |
|---|--------|-----------|--------|
| 1 | `harbor secrets` — keychain-backed secret store + config scanner | no | small |
| 2 | HITL approval gate — human approves a cross-room load | no | medium |
| 3 | Pool isolation — agents lose direct filesystem read of the pool | **yes** | large |

---

## Why, in one paragraph

Harbor today is **cooperative, tool-level enforcement**. That is a documented,
deliberate position and it is the right default. But it means two things are
true at once: the room gate genuinely stops accidents and misconfiguration
(which is what the July audit found — a *bug*, not an attack), and it stops
nothing at all against a process that simply reads `~/.agents/skills/**`
directly or rewrites its own `AGENT_ENV_ROOM`. Items 2 and 3 exist to close
that second gap, in that order, because **an approval prompt is theatre while
the files are readable anyway**. Item 1 is independent and just removes standing
credentials from disk.

---

## 1. `harbor secrets`

### Problem

Agent configs carry live credentials in plaintext: on the audited machine,
a Zapier bearer, an Obsidian REST key, and a GitHub PAT across three files
(plus an `agent-cards` JWT that had expired eleven days earlier and was still
sitting there). The manual fix — move to the OS keychain, reference `${VAR}` —
worked but lives in one machine's `~/.zshrc` and is not reproducible.

Secondary finding that raises the stakes: **Antigravity does not filter the
environment it hands to MCP servers.** Every server it spawns sees the full
ambient environment, including `SSH_AUTH_SOCK` and any exported keys. Cursor and
Codex scrub; Antigravity does not. So "just export everything" is not a safe
default.

### Interface

```
harbor secrets set <name>            # value read from STDIN, never argv
harbor secrets get <name>            # value to stdout (for $(...) capture)
harbor secrets list                  # names + lengths only, never values
harbor secrets rm <name>
harbor secrets export [--shell zsh]  # emit export lines for eval/sourcing
harbor secrets doctor [--fix]        # scan agent configs for plaintext secrets
```

### Design notes

- **Value never touches argv.** `set` reads stdin; `security add-generic-password
  -w <value>` puts the secret in the process table for the lifetime of the call,
  so the implementation must use the stdin-capable path or an equivalent. This
  is a hard requirement, not a nicety — a prior incident on this machine leaked
  a token into a transcript via `source <(grep …)`.
- **`list` and `doctor` never print values.** Name, length, and first four
  characters at most. Every diagnostic in this codebase follows that rule.
- **Backend is pluggable**: macOS `security` (service `harbor-managed`), Linux
  `secret-tool`, and a `0600` file fallback that warns loudly.
- **`doctor` is the highest-value verb.** It walks the same agent config paths
  `install.ts` already knows (`AGENTS[*].pathFromHome`) and flags any value that
  looks like a credential and is not a `${VAR}` reference. It reuses the agent
  registry, so a newly supported agent is scanned automatically.
- `doctor` must also flag **expired** JWTs, not just present ones. The audit's
  most useful single finding was that an 849-character token was inert.

### Non-goals

Rotation, sharing, and remote secret backends (Vault, 1Password). Out of scope.

---

## 2. HITL approval gate

### Problem

A cross-room skill load is currently a binary, silent decision: allowed or
denied, decided entirely by config. There is no way for a human to say "yes,
just this once" — and no way to be *told* it happened at all until the audit log
is read after the fact.

### Interface

```ts
export interface ApprovalRequest {
  sessionId: string;
  room: string;          // the room the session is scoped to
  tool: string;          // e.g. "read_skill"
  resource: string;      // e.g. "nda-review"
  targetRoom: string;    // the room the resource actually belongs to
  reason: string;        // why the gate fired, human-readable
}

export interface ApprovalDecision {
  granted: boolean;
  /** Epoch seconds. A grant is ALWAYS time-boxed; there is no permanent yes. */
  expiresAt?: number;
  approver?: string;
}

export interface ApprovalTransport {
  readonly name: string;
  request(req: ApprovalRequest, timeoutMs: number): Promise<ApprovalDecision>;
}
```

### The constraint that shapes the whole design

**The MCP server cannot prompt on its own stdin/stdout.** Those are owned by the
JSON-RPC framing — writing a prompt there corrupts the protocol stream. So an
approval transport is necessarily *out of band*. This rules out the obvious
"just ask on the terminal" implementation and is the main reason this is
medium-effort rather than small.

Transports, in build order:

| Transport | Mechanism | Use |
|-----------|-----------|-----|
| `deny` | returns `{granted:false}` immediately | **default** — preserves today's behavior exactly |
| `file` | writes a request JSON, polls for a decision file | headless, daemons, testable |
| `socket` | unix socket to a listening `harbor approve` TUI | interactive operator |
| `push` | existing notification gateway | away-from-keyboard |

### Rules

- **Fail closed.** Timeout, transport error, malformed decision, unparseable
  file → deny. Never "allow on error".
- **Grants are time-boxed and scoped** to `(sessionId, targetRoom, resource)`.
  No permanent approvals; no room-wide blanket grants in v1.
- **Every request and outcome is audited**, including timeouts, with the same
  `audit.allow` / `audit.deny` calls the gate already uses.
- **Default is `deny`**, so installing this changes nothing until a room opts in
  via `approval = "on-deny"` in its config. This is what makes item 2
  non-breaking.
- The grant store is a new table in the existing SQLite state, not a new
  database.

### Honest limitation

This closes the **MCP tool path**. It does not stop an agent from reading the
skill file directly. Item 3 is what makes this binding; until then item 2 buys
visibility and friction, not enforcement. That should be stated in the README
when it ships, in the same plain terms the existing security section uses.

---

## 3. Pool isolation

### Goal

Make Harbor the *only* reader of the skill pool, so that room scoping is
enforced by the kernel rather than by the agent's cooperation.

### The hard part, stated plainly

On a single-user macOS machine the agents run **as the operator**. File
permissions cannot separate a process from its own uid. So real isolation
requires one of:

- **(a) Agents run as a restricted uid** distinct from the pool owner. Cleanest
  conceptually, but changes how every agent is launched, and macOS-native skills
  (AppleScript, Apple Notes, iMessage, computer-use) may break or need
  additional TCC grants under a different user.
- **(b) Pool owned by a dedicated uid, reached through a privileged helper.**
  Keeps launches unchanged; introduces a setuid/setgid helper, which is a
  well-known source of privilege-escalation bugs and needs its own review.

Neither is free. **(a) is the recommended direction**, but it is a migration,
not a patch.

### Why containers are NOT the answer here

Apple's `container` (macOS 26+) gives per-container microVMs that exit when
idle, which fits an on-call agent fleet far better than Docker's always-on VM.
But it runs **Linux** containers, and a large share of this machine's
`productivity` room is macOS-native — `apple-notes`, `apple-reminders`,
`imessage`, `findmy`, `macos-computer-use`, `voice-interaction`. Those cannot
run in a Linux container at all. Containerizing that room does not secure it, it
breaks it. Containers remain a reasonable *later* option for rooms that need no
host access (devops, research, legal), layered on top of (a) — not instead of
it.

### Mandatory first step: `harbor isolation doctor --dry-run`

Before any permission changes, ship a command that reports **what would break**:

- every process/tool currently reading the pool directly (beacon generation,
  `skills_index.md`, room indexes, any skill that greps the pool)
- every skill whose content implies host access that a restricted uid would lose
- the exact chmod/chown plan, printed and applied only with an explicit flag

This is non-negotiable. A permission change to `~/.agents/skills` that is wrong
in either direction either locks the operator out of their own skills or
silently leaves the hole open. The dry run is how we find out which, before it
matters.

### Rollout

1. `harbor isolation doctor` — report only, no changes. **Ship and read the
   output before designing further.**
2. Decide (a) vs (b) *from that report*, not from this document.
3. Migrate one low-risk room end to end (`research` or `devops`).
4. Roll forward per room, never wholesale.

---

## Build order

1. **`harbor secrets`** — self-contained, immediately useful, zero breakage.
2. **Approval gate with the `deny` + `file` transports** — default off.
3. **`harbor isolation doctor`** — report only.
4. Everything after step 3 is designed against real output, not this spec.

Steps 1–3 are safe to build now. Step 4 deliberately has no design in this
document, because writing one before seeing the doctor output would be guessing
— which is precisely the failure mode that produced the bug this spec exists to
prevent.
