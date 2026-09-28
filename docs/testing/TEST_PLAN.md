# Test Plan — Enterprise IT Helpdesk Lab

**Contract:** [`docs/qa/QA_ACCEPTANCE.md`](../../docs/qa/QA_ACCEPTANCE.md).
**Case IDs:** Portal `HD-001` → `HD-020`, Infrastructure `INF-001` → `INF-012` in `TEST_CASES.md`.
**Runners:** `node --test` in `internal-portal/` (29 files, **254 `test()` blocks**, 323 executed
with subtests) + `python3 -m unittest` in `internal-portal/python-portal/` (14 files,
**86 `def test`**). Infra cases (AD/DNS/DHCP/GPO) are procedural runbook tests, not unit tests.

## Scope

Portal: Bearer auth (valid/missing/invalid/expired), RBAC (403 matrix), ticket CRUD +
state machine, concurrent-update safety, notification-failure transaction design,
async rollback/retry without duplicates, OpenAPI contract match, oversized/invalid
payloads, restart persistence, corrupt-`db.json` recovery, backup restore.
Infra: DHCP lease/renew, DNS A records + negative answers, AD join/login/deny,
GPO targeting, security-policy matrix, DNS-down observability.

## Levels

| Level | What | Where |
|---|---|---|
| Unit (node) | auth gates, state-transition validation, payload validation | `auth-boundary` (4), `api-contract` (6), `packaging` (14) |
| Integration (node) | ticket lifecycle + notification failure paths + async compensation | `ticket-alert` (3), `notifier-safety` (4), `transaction-rollback` (6) |
| Race | concurrent update (no silent overwrite), notifier ordering (no duplicates) | `overlap-behavior` (14), `notifier-ordering` (8), `transaction-rollback` (6) |
| Adversarial | AI prompt-injection suite; live part skipped without `LIVE_TESTS=1` | `ai-adversarial.test.js` (2) |
| Contract | OpenAPI vs implemented routes (100% match), unknown route → safe 404 | `openapi-yaml` (9), `route-inventory` (18), `route-coverage` (7) |
| Persistence / Recovery | restart, corrupt db.json, backup restore with integrity check | `store-journal` (4), `store` (7), `api-persistence` (4) |
| Live | `live-guard.test.js` (3): closed-port probe, `LIVE_TESTS` gate | skip-by-default, never fail offline |
| Infra runbook | INF-001→INF-012 against the lab with command-output evidence | manual / UNVERIFIED here |

## Environments

| Env | Command | Scope |
|---|---|---|
| Offline (node) | `node --test 'test/*.test.js'` | **322 pass / 0 fail / 1 skip** (2026-09-27) |
| Offline (python-portal) | `DATA_FILE=<tmp>/db.json PORT=0 python3 -m unittest discover -s . -p 'test_*.py'` | **BLOCKED offline** — no local interpreter has `flask` (verified 2026-09-27); CI-ONLY, last-known 79+6 pass |
| CI | `npm test` + python unittest + `swagger-cli` OpenAPI gate (BLOCKING) | full gate |
| Live-infra | `LIVE_TESTS=1` | AI adversarial live test; AD/DNS/DHCP lab for INF-* |

## Entry / exit criteria

- Entry: lab topology up (or documented BLOCKED per case); `db.json` fixture seeded.
- Exit: HD P0 100% PASS; INF cases PASS or BLOCKED-with-cause (infra-dependent);
  no silent overwrites, no duplicate side effects on retry.

## Invariants under test

```text
no auth -> no access; wrong role -> no admin action
failed notify/action -> defined transaction state + compensation, never duplicates
```
