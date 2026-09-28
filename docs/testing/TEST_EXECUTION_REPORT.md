# Test Execution Report — Enterprise IT Helpdesk Lab

Cases: [`TEST_CASES.md`](TEST_CASES.md) (`HD-001`→`HD-020`, `INF-001`→`INF-012`).
Evidence dir: [`evidence/`](evidence/). Session date: 2026-09-27 UTC.

| Date (UTC) | Command | Scope | Result | Verdict | Evidence |
|---|---|---|---|---|---|
| 2026-09-28 | `npm test -- --run` (in `internal-portal/`, node v22.20.0) | HD-001→020 (323 tests: auth, tickets, assets, approvals, transactions, UI) | **322 pass / 0 fail / 1 skip** (38.8 s) — skip = `ai-adversarial` live test (`LIVE_TESTS!=1` by design) | **QA READY (PASS ✅)** | [`evidence/2026-09-28-node-suite.log`](evidence/2026-09-28-node-suite.log) |
| 2026-09-27 | `node --test 'test/*.test.js'` (in `internal-portal/`, node v22.20.0) | HD-001→020 (323 executed incl. subtests) | **322 pass / 0 fail / 1 skip** (76 s) — skip = `ai-adversarial` live test (`LIVE_TESTS!=1` by design) | VERIFIED ✅ | `evidence/2026-09-27-node.log` |
| 2026-09-27 | `DATA_FILE=/tmp/hd-qa-db.json PORT=0 python -m unittest discover -s . -p 'test_*.py'` (in `python-portal/`, factorygen interpreter) | python-portal (85 collected of 86 defs) | 30 ok / 4 failures / 51 errors — **all errors root-caused to missing `flask`** in every local interpreter (sys, factorygen, gateway venv all lack it) | ENV-BLOCKED (CI-ONLY) | `evidence/2026-09-27-python-portal.log` |
| — | python-portal in CI (with `pip install -r requirements.txt`) | HD dual-implementation rows | UNVERIFIED — last-known 79 pass + 6 Phase-2 (HARD_TEST_REPORT.md §III) | UNVERIFIED | rerun in CI |
| — | INF-001→012 runbooks | AD/DNS/DHCP/GPO lab | UNVERIFIED — no lab here | UNVERIFIED | per-case logs when lab runs |
| 2026-09-27 | `npm test` (in `internal-portal/`, node v22.20.0) — re-confirm run | portal, full | **322 pass / 0 fail / 1 skip** (37.9 s; skip = live adversarial, `LIVE_TESTS!=1` by design) | VERIFIED ✅ | `evidence/2026-09-27-npm-test.log` |
| 2026-09-27 | `DATA_FILE=/tmp/hd-qa-db.json PORT=0 /tmp/flaskportal_venv/bin/python -m unittest discover -s python-portal -p 'test_*.py'` | python-portal (Flask 3.1.3 venv) | **Ran 85 tests … OK** (38.4 s) | VERIFIED ✅ (closes ENV-HD-001) | `evidence/2026-09-27-python-portal-venv.log` |

> SURPRISE: node count is **322/1 skip**, not the 278/1 in HARD_TEST_REPORT.md
> (nor the 269 badge) — suite grew; badge needs a rerun + update (open gap §VII stands).

## How to record a run

1. Portal: `npm test` in `internal-portal/`; save output under `evidence/`.
2. Infra runbooks (INF-*): paste command + output per case under
   `evidence/YYYY-MM-DD-INF-<id>.log`.
3. Fill one row above; update `Status` in `TEST_CASES.md`.
4. Any FAIL/FLAKY gets an entry in `DEFECT_REPORT.md` before the run counts as reviewed.
