# Contributing to agent-environment

Thank you for your interest. This document covers the build conventions, code
standards, and gate process for the `agent-environment` package.

## Quick start

```bash
git clone <repo-url>
cd agent-environment
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest                          # all tests must be green before any PR
```

Requires Python 3.10+.

## Repository layout

```
agent_env/          Package source (6 modules + config + environment + CLI)
  demo/             Demo content assets materialized by `setup --demo`
agent_env/cli.py    `agent-env` console entry point
tests/              pytest test suite (one file per module)
  fixtures/         Committed generic fixtures for golden rendering
  golden/           Golden files (machine-independent, path-normalized)
  golden_render.py  Standalone golden verification/update harness
```

## Development rules

### Isolation
Never write to the real `$HOME`, `~/.agent-env/`, `~/agent_map.md`, or any
real home path during tests or CI. Every test that touches the filesystem must
use `tmp_path`. The live machine is the first migration target; tests must never
alter it.

### No mocking the filesystem
Use real `tmp_path` directories for all filesystem tests, not `unittest.mock`.
This is a project-wide constraint (plan.md decision #4).

### No personal data in committed files
The demo grep gate is absolute: no personal-domain strings (project names,
personal paths, etc.) in any committed file under `agent_env/`, `tests/`, or
docs. Verify by running the gate command from `plan.md §Phase 5` before
committing.

### Golden files
Update goldens when generator output intentionally changes:

```bash
python3 tests/golden_render.py --update    # regenerate from generic fixture
python3 tests/golden_render.py             # verify all pass
git add tests/golden/
```

Golden files use `<HOME>` and `<TS>` placeholders (path + timestamp
normalized) so they contain no machine-specific data.

### Dependencies
Runtime: stdlib-only on Python 3.11+. `tomli` is the only runtime dependency
on Python 3.10 (`tomli; python_version < "3.11"` in pyproject.toml). Do not
add new runtime dependencies without a strong justification.

## Test standards

- Every new module needs a corresponding `tests/test_<module>.py`
- Coverage gate: `pytest --cov=agent_env --cov-fail-under=80`
- Tests assert behavior (generated content, file states), not implementation details
- Parametrize where multiple cases share identical structure

## Submitting changes

1. Work on a feature branch (never push directly to `main`)
2. All tests green twice (run order randomized: `pytest -p randomly`)
3. Coverage ≥ 80% for the changed module
4. Run the demo grep gate (see above)
5. Update `CHANGELOG.md` under `[Unreleased]`
6. Open a PR; gate review is done in a fresh session (author never grades own work)

## Phase gate process

Major phases (as defined in `plan.md`) require an independent gate review:
- A reviewer in a fresh context verifies the correctness criteria
- A test engineer re-runs the full suite + coverage
- The author does not participate in grading their own phase

See `build-status.md` for the current phase boundary and open findings.
