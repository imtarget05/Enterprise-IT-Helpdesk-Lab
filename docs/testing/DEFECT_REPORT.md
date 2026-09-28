# Defect Report — Enterprise IT Helpdesk Lab

| ID | Severity | Title | Repro | Evidence | Status |
|---|---|---|---|---|---|
| ENV-HD-001 | S4 (env-only) | python-portal suite (85 collected) red offline: 51 errors + 4 failures, all root-caused to `ModuleNotFoundError: flask` (`app.py:35`) in every local interpreter (system, factorygen, gateway venv). 30 flask-free tests pass. | 2026-09-27: `DATA_FILE=/tmp/hd-qa-db.json PORT=0 python -m unittest discover` → `Ran 85 tests … FAILED (failures=4, errors=51)` | `evidence/2026-09-27-python-portal.log` | FIXED 2026-09-27: `/tmp/flaskportal_venv` carries Flask 3.1.3 → same command `Ran 85 tests … OK` (38.4 s). Env-only, never an app defect (`evidence/2026-09-27-python-portal-venv.log`) |
| HIST-HD-001 | (historical, FIXED — verified on disk) | Portal DATA_DIR relative-mount risk: Flask `DATA_FILE` could resolve into (or clobber) the Node portal's `data/db.json` | Fixed state on disk: `python-portal/app.py:41-63` (absolute `BASE_DIR`-derived `_DEFAULT_DATA_FILE`, `NODE_DATA_FILE` comparison, fail-closed abort on clash or unresolvable path); enforced by `tests/test_app_isolation.py` + `test_isolation.py` (assert `_DEFAULT_DATA_FILE = (BASE_DIR / "data" / "db.json")` and fail-fast on Node-db pointing) | `app.py:41-63`, `tests/test_app_isolation.py:113-148` | FIXED (code + tests on disk; suite itself CI-ONLY offline) |

Node suite 2026-09-27: 322 pass / 0 fail / 1 skip (skip by design) — no defects.

## Lifecycle

`OPEN → FIXED` (with re-test evidence) or `OPEN → MITIGATED` (workaround +
root-cause tracking ID) or `→ WONTFIX` (justification required for P0/P1).
Every defect links the failing case ID from `TEST_CASES.md`.
