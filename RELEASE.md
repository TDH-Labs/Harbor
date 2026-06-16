# Release Checklist — agent-environment

This checklist walks the operator through every step for a public release.
Steps marked **[OPERATOR]** require interactive browser or secret-vault access
and are **never automated**. Steps marked **[SCRIPT]** are fully scripted.

---

## Pre-flight (run on the build branch before tagging)

- [ ] **Version consistent** — confirm these three match:
  - `pyproject.toml` → `version = "0.1.0"`
  - `agent_env/__init__.py` → `__version__ = "0.1.0"`
  - `CHANGELOG.md` → `## [0.1.0]` entry with today's date
  ```bash
  grep 'version' pyproject.toml agent_env/__init__.py CHANGELOG.md | head -5
  ```

- [ ] **Full test suite green twice** with coverage ≥ 80%:
  ```bash
  pytest tests/ --cov=agent_env --cov-fail-under=80 -q
  pytest tests/ --cov=agent_env --cov-fail-under=80 -q  # second run
  ```

- [ ] **Personal-data gate clean** (source + docs, excluding tests/):
  ```bash
  # The gate runs automatically in CI (personal-data-gate.yml on every push).
  # For the exact grep pattern, flags, and exclusions see that workflow file.
  # Must produce NO output from the gate scan.
  ```

- [ ] **README placeholders replaced**:
  - [ ] `yourname/agent-env` → real repo slug (2 occurrences: badge + link)
  - [ ] `<!-- replace before first release: swap docs/demo.gif …  -->` removed; real GIF committed
  - [ ] `<!-- replace before first release: run agent-env check …  -->` removed; real check output pasted in
  ```bash
  grep "replace before first release\|yourname" README.md
  # Must produce NO output.
  ```

- [ ] **demo.gif committed**:
  ```bash
  ls docs/demo.gif   # must exist
  ```

- [ ] **Build passes locally**:
  ```bash
  python -m build
  twine check dist/*
  # Both must print PASSED.
  ```

- [ ] **Smoke test from wheel** (fresh venv, no editable install):
  ```bash
  SMOKE=$(mktemp -d)/smoke && python -m venv "$SMOKE"
  "$SMOKE/bin/pip" install dist/agent_environment-0.1.0-py3-none-any.whl
  "$SMOKE/bin/agent-env" --help
  "$SMOKE/bin/agent-env" setup --demo /tmp/smoke-demo
  # Expect: ~17 files created, check: PASS
  rm -rf "$SMOKE" /tmp/smoke-demo
  ```

---

## Fresh-history cut (REQUIRED before public push)

The development history contains internal process documents (`plan.md`,
`ARCHITECT_BRIEF.md`, `build-status.md`, `scratchpad*.md`) that contain
personal-domain strings.  The public repo is a **clean-history snapshot** —
only the final working tree.

See [`scripts/fresh_history_cut.sh`](scripts/fresh_history_cut.sh) for the
full automated procedure.  Summary:

Use [`scripts/fresh_history_cut.sh`](scripts/fresh_history_cut.sh) — it
handles all excludes and gate verification automatically.  The manual
equivalent (for reference) mirrors the script exactly:

```bash
# 1. Create a clean public repo directory
mkdir ~/agent-env-public && cd ~/agent-env-public
git init -b main

# 2. Copy only shipping files — excludes must match fresh_history_cut.sh
rsync -a \
  --exclude=".git/" \
  --exclude=".github/personal-terms.txt" \
  --exclude=".claude/" \
  --exclude=".venv/" \
  --exclude=".ruff_cache/" \
  --exclude=".pytest_cache/" \
  --exclude="dist/" \
  --exclude="build/" \
  --exclude="*.egg-info/" \
  --exclude="__pycache__/" \
  --exclude="*.pyc" \
  --exclude=".coverage" \
  --exclude="AGENTS.md" \
  --exclude="plan.md" \
  --exclude="ARCHITECT_BRIEF.md" \
  --exclude="build-status.md" \
  --exclude="scratchpad.md" \
  --exclude="scratchpad_*.md" \
  --exclude="scratchpad_*.tsv" \
  --exclude="research.md" \
  --exclude="config.local.toml" \
  --exclude="tests/phase0_source_hashes.txt" \
  --exclude="tests/FINDINGS.md" \
  --exclude="scripts/fresh_history_cut.sh" \
  ~/workspace/agent-environment/ ~/agent-env-public/

# 3. Verify generic gate on the public tree — handled automatically by the
#    script (Step 2 of fresh_history_cut.sh).  See that script for the exact
#    find + grep command.  Must produce NO output from the gate scan.

# 4. Initial commit
git add .
git commit -m "Initial release: agent-environment 0.1.0"

# 5. Tag
git tag -a v0.1.0 -m "Release 0.1.0"
```

---

## GitHub setup [OPERATOR]

- [ ] **Create public repo** on GitHub (or GitLab/Codeberg):
  - Name: `agent-env` (or your preferred slug)
  - Visibility: Public
  - Initialize: **empty** (no README, no .gitignore — we push ours)

- [ ] **Update README slug** — replace `yourname/agent-env` with the real
  `<username>/<repo>` in `README.md` (2 places).

- [ ] **Add PYPI_API_TOKEN secret** to the repo:
  - GitHub → Settings → Secrets and variables → Actions → New repository secret
  - Name: `PYPI_API_TOKEN`
  - Value: your PyPI API token (generate at https://pypi.org/manage/account/token/)

- [ ] **Push the public repo**:
  ```bash
  cd ~/agent-env-public
  git remote add origin https://github.com/<username>/agent-env.git
  git push -u origin main
  git push origin v0.1.0
  ```
  The tag push triggers `release.yml` → builds → publishes to PyPI
  (requires the `PYPI_API_TOKEN` secret to be set first).

---

## Post-push verification [OPERATOR]

- [ ] **CI green** — all four matrix jobs (ubuntu × macos × Python 3.10–3.13)
  pass on the Actions tab.

- [ ] **Personal-data gate green** — the gate job in Actions shows ✅ PASSED.

- [ ] **PyPI package live**:
  ```bash
  pip install agent-environment==0.1.0
  agent-env --help
  ```

- [ ] **End-to-end smoke on a clean machine**:
  ```bash
  pip install agent-environment
  agent-env setup --demo /tmp/first-demo
  cat /tmp/first-demo/agent_map.md
  agent-env init   # answer the 6 questions
  agent-env setup --root /tmp/test-env
  agent-env check --root /tmp/test-env
  ```

---

## CHANGELOG entry

Update `CHANGELOG.md` before tagging:

```markdown
## [0.1.0] — YYYY-MM-DD

First public release.  (see existing entry for full details)
```

---

## TODO items carried to future releases

These are known improvements deferred from 0.1.0:

- `docs/demo.gif` — record a 90-second screencast once the environment is live
- `README.md` agent-env check output block — replace placeholder with real output
- PyPI OIDC trusted publishing (replace token-based auth)
- Homebrew tap formula (stretch goal from Phase 6)
- `agent-env migrate` v1.0 → v1.1 transition (when schema bumps)
