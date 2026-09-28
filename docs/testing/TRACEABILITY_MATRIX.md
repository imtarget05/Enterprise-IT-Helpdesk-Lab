# Traceability Matrix — Enterprise IT Helpdesk Lab

`Requirement → Business Rule → Test Case → Automated Test → Execution Evidence`

| Business invariant | Test Case | Automated test (exact file, on disk) | Source file | Evidence |
|---|---|---|---|---|
| AUTH_401_RBAC_403 (no token → 401; wrong role → 403) | HD-001–006 | `auth-boundary.test.js` (4 `test()`), `enterprise-upgrade.test.js` (6), `route-inventory.test.js` (18) | `internal-portal/test/` | VERIFIED 2026-09-27 (in 322-run) |
| NO_SILENT_OVERWRITE (concurrent update safe) | HD-010 | `transaction-rollback.test.js` (6), `overlap-behavior.test.js` (14) | `internal-portal/test/` | VERIFIED 2026-09-27 |
| NO_DUPLICATE_NOTIFY (retry → single effect) | HD-011–013 | `notifier-safety.test.js` (4), `notifier-ordering.test.js` (8), `csv-notify.test.js` (10) | `internal-portal/test/` | VERIFIED 2026-09-27 |
| CONTRACT_MATCH (OpenAPI == routes; 404 safe) | HD-014, HD-015 | `openapi-yaml.test.js` (9), `route-inventory.test.js` (18), `route-coverage.test.js` (7), `factory-delivery.test.js` (5) | `internal-portal/test/` | VERIFIED 2026-09-27 |
| PERSIST_SURVIVES_RESTART (restart/corrupt/restore) | HD-018–020 | `store-journal.test.js` (4), `store.test.js` (7), `api-persistence.test.js` (4) | `internal-portal/test/` | VERIFIED 2026-09-27 |
| DATA_ISOLATION (Flask never touches Node db; fail-closed) | HD-007–010, HD-018–020 (python side) | `tests/test_app_isolation.py` (9), `test_isolation.py` (3), `tests/test_data_safety.py` (13) | `internal-portal/python-portal/` | VERIFIED 2026-09-27 (85/85 OK in flask venv; closes ENV-HD-001) |
| ATOMIC_MUTATION (failed save → RAM unchanged, no tmp left) | HD-011–013 (python side) | `tests/test_atomic_mutations.py` (11), `tests/test_ai_lock.py` (10), `tests/test_concurrency.py` (7) | `internal-portal/python-portal/` | VERIFIED 2026-09-27 (85/85 OK in flask venv) |
| INF_RUNBOOK (DHCP/DNS/AD/GPO observable) | INF-001–012 | procedural (no unit test by design) | `docs/02-ad-dns-dhcp-setup.md` etc. | UNVERIFIED (no lab) |
