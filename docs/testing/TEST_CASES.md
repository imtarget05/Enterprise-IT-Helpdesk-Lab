# Test Cases — Enterprise IT Helpdesk Lab

**Plan:** [`TEST_PLAN.md`](TEST_PLAN.md). **Contract:** `docs/qa/QA_ACCEPTANCE.md`.
Node: 29 files / 254 `test()` (323 executed). Python-portal: 14 files / 86 `def test`.
✅ = ran green 2026-09-27.

## Portal / API (node — all ✅ 322 pass / 1 skip this session)

| ID | file::case (on disk) | Invariant asserted | Runnable offline? |
|---|---|---|---|
| HD-001 | `auth-boundary.test.js` (4 `test()`) valid-token path ✅ | auth → access | ✅ |
| HD-002 | `auth-boundary.test.js` no-token path ✅ | no token → `401` | ✅ |
| HD-003 | `auth-boundary.test.js` bad-signature path ✅ | forged → `401` | ✅ |
| HD-004 | `auth-boundary.test.js` expired-token path ✅ | expired → `401` | ✅ |
| HD-005 | `auth-boundary.test.js` + `enterprise-upgrade.test.js` (6) wrong-role path ✅ | wrong role → `403` | ✅ |
| HD-006 | `route-inventory.test.js` (18) + admin-guard path ✅ | admin endpoints blocked | ✅ |
| HD-007 | `api-tickets.test.js` (10) create path ✅ | ticket persisted, numeric ID | ✅ |
| HD-008 | `api-tickets.test.js` missing-field path ✅ | `400`, no junk ticket | ✅ |
| HD-009 | `api-contract.test.js` (6) + `api-contract-dto.test.js` (14) ✅ | invalid transition → `422` | ✅ |
| HD-010 | `transaction-rollback.test.js` (6) + `overlap-behavior.test.js` (14) ✅ | no silent overwrite | ✅ |
| HD-011 | `notifier-safety.test.js` (4) + `csv-notify.test.js` (10) ✅ | notify fail → safe ticket state | ✅ |
| HD-012 | `transaction-rollback.test.js` disk-full path ✅ | rollback/compensation runs | ✅ |
| HD-013 | `notifier-ordering.test.js` (8) ✅ | retry → no duplicate notify | ✅ |
| HD-014 | `openapi-yaml.test.js` (9) + `factory-delivery.test.js` (5) ✅ | 100% contract match | ✅ |
| HD-015 | `route-coverage.test.js` (7) ✅ | unknown route → safe 404 JSON | ✅ |
| HD-016 | `packaging.test.js` (14) ✅ | oversized body rejected | ✅ |
| HD-017 | `api-misc.test.js` (8) + `api-contract.test.js` ✅ | bad JSON → process survives | ✅ |
| HD-018 | `store-journal.test.js` (4) + `store.test.js` (7) + `api-persistence.test.js` (4) ✅ | restart → data intact | ✅ |
| HD-019 | `store-journal.test.js` corrupt-recovery path ✅ | `.corrupt-<ts>` backup + safe init | ✅ |
| HD-020 | `store-journal.test.js` restore path ✅ | checksum-verified restore | ✅ |

## Portal (python-portal — dual implementation, flask; CI-ONLY offline)

| ID | file::case (on disk, 86 defs) | Invariant | Offline? |
|---|---|---|---|
| HD-007–010 | `tests/test_http_isolated.py` (1), `tests/test_concurrency.py` (7), `tests/test_data_safety.py` (13) | CRUD + concurrency safety | CI-ONLY (no flask) |
| HD-011–013 | `tests/test_ai_lock.py` (10), `tests/test_atomic_mutations.py` (11) | notify-fail atomicity, no dup | CI-ONLY |
| HD-014 | `tests/test_ci_contract.py` (4), `tests/test_merge_contract_round3.py` (5) | contract parity | CI-ONLY |
| HD-018–020 | `tests/test_data_safety.py`, `test_isolation.py` (3), `tests/test_app_isolation.py` (9) | DATA_FILE isolation, recovery | CI-ONLY |
| HD-ALL | `tests/test_invariants.py` (7), `tests/test_rag_cache_policy.py` (6), `tests/test_rag_retrieve_cache.py` (4), `tests/test_rag_thread_safety.py` (3), `tests/test_node_store_interop.py` (3) | invariants + RAG cache | CI-ONLY |

## Infrastructure (runbook, command-output evidence — UNVERIFIED here, no AD lab)

| ID | Scenario | Expected | Status |
|---|---|---|---|
| INF-001 | Client gets DHCP | Correct IP/range/gateway/DNS | UNVERIFIED |
| INF-002 | DHCP lease renew | Renews successfully | UNVERIFIED |
| INF-003 | Internal DNS A record | Resolves correctly | UNVERIFIED |
| INF-004 | Invalid hostname | NXDOMAIN, no fake record | UNVERIFIED |
| INF-005 | Domain join | Client joins AD | UNVERIFIED |
| INF-006 | Valid domain login | Succeeds | UNVERIFIED |
| INF-007 | Invalid password | Denied + Event 4625 | UNVERIFIED |
| INF-008 | Locked/disabled account | Login denied | UNVERIFIED |
| INF-009 | GPO target OU | Policy applied | UNVERIFIED |
| INF-010 | User outside OU | No wrong GPO | UNVERIFIED |
| INF-011 | Security policy | Matches matrix | UNVERIFIED |
| INF-012 | DNS unavailable | Runbook-observable | UNVERIFIED |

## Full-run verdicts 2026-09-27

- Portal (node v22.20.0): **322 pass / 0 fail / 1 skip** re-confirmed
  (`evidence/2026-09-27-npm-test.log`; skip = live adversarial gateway test,
  `LIVE_TESTS!=1` by design). HD-001→020 PASS.
- python-portal (Flask 3.1.3 venv): **85/85 OK** — closes ENV-HD-001; dual-implementation
  isolation/atomicity rows above now VERIFIED.
- INF-001→012: still UNVERIFIED (no AD lab on this host) — documented env limitation.

**Gate verdict: CONDITIONAL PASS** — portal + python-portal fully green; INF runbooks
require the Windows lab.
