# Phase 6 — Ship: builder notes

Branch `phase-6-ship` off `main` @ `ab47ef7` (Phase 5 GO, 343 green). This phase is
packaging, distribution, docs, and the final de-personalization gate — no new core modules.

## What changed

| Area | Change |
|------|--------|
| `package.json` | version `0.1.0` → **`1.0.0`** (publish candidate). Added `keywords`, `engines.bun`, and an explicit **`files` allowlist** (negated globs) so the tarball ships only product `src/**/*.ts` + `integrations/**/*.ts` + README/LICENSE/tsconfig — no `*.test.ts`, no `test-setup.ts`, no `concurrency.worker.ts`. |
| `src/cli.ts` | Added the **`setup`** subcommand (builds the directory tree from config + generates beacons; idempotent `mkdir -p`) and wired **`--version`** via `meta.version` sourced from `package.json` (single source of truth). Added a `#!/usr/bin/env bun` shebang so the `bin` is `npx`-executable. New exported helper `setupTree(env)`. |
| `tsconfig.json` | `resolveJsonModule: true` (for the `package.json` version import). |
| `LICENSE` | MIT, de-personalized ("Harbor contributors", no author name). |
| `README.md` | Full getting-started: install, `init`/`setup`/`check` quickstart, `harbor install --for <agent>`, CLI reference, programmatic use, single-binary, **honest-enforcement section** (tool-level boundary not OS sandbox; `AGENT_ENV_ROOM` cooperative trust boundary; `roomSkillAllowed` returns true when no skill list configured — documented as by-design). |
| `.github/workflows/ci.yml` | Two jobs: `bun test` + `tsc`, and a de-personalization gate (with a planted-path self-test) that fails on `/Users/<user>/` or `/home/<user>/` in shipping source. |
| `.gitignore` | Added `*.tgz`. (`dist/` already ignored.) |
| Tests | `src/packaging.test.ts` (bin + every exports subpath resolve and import; npm-pack manifest excludes internal files and includes the product surface; init+setup clean-checkout flow under an explicit `--root` with an untouched throwaway `$HOME`). `src/depersonalization.test.ts` (pure-fs scan of the shippable surface for `/Users/`, `/home/<user>`, emails, personal taxonomy/MCP servers). `cli.test.ts` gains `--version` + `setup` coverage. |

## Proofs

- **Package manifest** — `npm pack --dry-run`: 31 files, zero `*.test.ts` / `test-setup.ts` /
  `concurrency.worker.ts` / `PHASE*_NOTES.md` / `bunfig.toml` / `bun.lock` / `dist/`. Full product
  `src/` + `integrations/` surface present.
- **Single binaries** — `bun build --compile` for `bun-darwin-arm64` (Mach-O arm64) and
  `bun-linux-x64` (ELF x86-64), into `dist/` (gitignored). Host-arch binary verified:
  `harbor --version` → `1.0.0`, `harbor --help` (lists all 26 subcommands incl. `setup`),
  `harbor init`, `harbor setup`, `harbor check` — all green against a temp root.
- **Clean-checkout flow** — packed the tarball, `npm install -g --prefix <tmp>` (deps resolved,
  `harbor` bin linked via shebang), ran `harbor init && harbor setup && harbor check` against a
  temp `--root`; the live `~/.agent-env` was untouched. Also verified the literal
  `npx harbor init && npx harbor setup` from a stranger's local tarball install, plus
  `npx harbor sync --generate-only` producing a stamped `AGENTS.md`.
- **De-personalization** — scan over the extracted tarball + the whole tree: zero `/Users/`,
  `/home/<user>`, emails, personal room taxonomy (`finance_real_estate`, `bookkeeping`, `gaming`,
  `superpowers`, …), or personal MCP servers (QuickBooks, etc.). The only domain-ish words in
  shipping source are the SPEC's own generic illustrative examples (`legal`/`marketing`/
  `nda-review`/`case-brief`) in doc comments — they reveal nothing about the author. The `/Users/`
  and `quickbooks` strings elsewhere in the tree are negative test assertions and de-perso process
  docs (neither ships).
- **Tests + determinism** — full suite **359 pass / 0 fail**, `tsc --noEmit` clean. Determinism
  gate: **100/100** `bun test --randomize` (load-sensitive packaging/CLI subprocess tests included)
  + a follow-up **25/25** randomize including the new de-perso tests + a **4× concurrent-load
  burst** (all lanes 359/0). `npm publish --dry-run` succeeds.

## Honest-enforcement language (carried forward verbatim in spirit)

README §"Enforcement model" states plainly: the gate is **tool-level, not an OS sandbox** (raw
filesystem access bypasses it); the room is **host-assigned via `AGENT_ENV_ROOM`, a cooperative
trust boundary**, not OS-enforced isolation; and **no skill list configured ⇒ no skill restriction
(by design)** so an unconfigured environment is usable out of the box. No "enforced" over-claim.

## Gate

`tsc` clean, full suite green, artifacts built and flows proven locally. Per instructions: **not
published, not pushed.** Branch `phase-6-ship` holds the commit. Awaiting independent fresh-eyes
review (`REVIEW_06.md`) before any publish.
