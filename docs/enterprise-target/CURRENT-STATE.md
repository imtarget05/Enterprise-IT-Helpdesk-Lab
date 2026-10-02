# CURRENT STATE — Enterprise-IT-Helpdesk-Lab

```text
measured_at : 2026-10-02
method      : read-only for Azure (plan/CLI only); local suites re-run on branch tip.
mutations   : remote refs fetched; no destructive git against other writers' worktrees.
rule        : no number appears below unless it was measured here, or is explicitly
              labelled CARRIED_FORWARD_NOT_REMEASURED.
```

## 1. Identity

| Field | Value |
|---|---|
| remote | `https://github.com/imtarget05/Enterprise-IT-Helpdesk-Lab.git` |
| **canonical ref (`origin/main`)** | `3ad2449` (PR #4 — Bicep stack deleted; PR #3 — Terraform canonical) |
| local `main` | `66df1d5` — **stale, must not be quoted** |
| worker branch | `helpdesk/core-runtime` (`00c9873`, rebased on `3ad2449`) — Wave 2, pushed |
| worktree | **CLEAN** |
| Render purge | **DONE** — `render.yaml` + `keepalive.yml` removed in PR #1 (`f976d9b`); anti-Render gate `test_hygiene_no_render.py` (5 tests) merged |

**Concurrency hazard observed during this pass:** a second writer
(`feat/terraform-canonical`) and a third (`ent/enterprise-target`) worked on the
same repository, and `CURRENT-STATE.md` was edited outside this session.
Integrator action: preserve the foreign edit in a stash
(`/tmp/helpdesk-preserved/CURRENT-STATE.md.concurrent-writer-edit`), reset `main`
to `origin/main`, then re-verify everything before claiming anything. The local
Phase-1 commit `8838e03` was a duplicate of already-landed PR #3 and was
**dropped, not merged** — merging it would have reverted PR #1's Render purge.

## 2. Infrastructure as deployed today

| Field | Value |
|---|---|
| IaC language | **Terraform only** (`infra/terraform/`). The Bicep stack was **deleted** in PR #4 (`3ad2449`). |
| entrypoint | `infra/terraform/main.tf` + `modules/{network,keyvault,database,messaging,observability,apps}` |
| parameters | `infra/terraform/env/{dev,prod}.tfvars` |
| gates present | `terraform validate` · `terraform test` (13) · `check_plan_invariants.py` (13) · `scripts/tests/test_controls.py` (18 bite tests) |
| **gate LOST in PR #4** | the Bicep↔Terraform oracle: `check_parity.py` (130), `check_bicep_frozen.py`, `FROZEN.lock.json` + their `test_controls.py` classes. With Bicep gone the comparison target is gone; the port is now trusted on its own contract assertions only. Deliberate cost of "Terraform only" — recorded in PR #4's message, not hidden. |
| CI | `.github/workflows/{ci.yml,iac-validate.yml,terraform-validate.yml,build-container.yml,llm-gateway.yml}` |

## 3. Measured this pass (2026-10-02, branch `helpdesk/core-runtime` @ `00c9873`)

| Suite | Command | Result |
|---|---|---|
| Node portal | `cd internal-portal && npm test` | **388 — 381 pass, 7 skipped, 0 fail** |
| Node portal, with a real DB | `LIFECYCLE_PG_URL=… DATABASE_SSL=false npm test` | **388 — 387 pass, 1 skipped, 0 fail** |
| Governed lifecycle (unit) | `node --test test/action-lifecycle.test.js` | **31/31** |
| Governed lifecycle (REAL PostgreSQL 16) | `LIFECYCLE_PG_URL=… node --test test/action-lifecycle-postgres.test.js` | **6/6** |
| Auth fail-closed | `node --test test/auth-failclosed.test.js` | **5/5** |
| Service Bus bridge | `node --test test/servicebus-lifecycle-bridge.test.js` | **3/3** |
| Python portal (Flask) | `DATA_FILE=$(mktemp -d)/db.json PORT=0 python3 -m unittest discover` | **90 OK** |
| llm-gateway automation | `.venv-helpdesk/bin/python -m pytest llm-gateway/tests/ -q` | **71 passed, 4 xfailed** |
| PowerShell scripts | `bash scripts/verify-ps1-syntax.sh scripts` | **8/8 parse OK** |
| Terraform | `terraform validate` + `terraform test` | **valid / 13 passed, 0 failed** |
| Terraform control bite tests | `python3 -m unittest discover -s infra/terraform/scripts/tests` | **18/18 OK** |
| CI @ `origin/main` | `gh run list` (PR #4 merge) | **CI ✓ · IaC Validate ✓ · Terraform Validate ✓** |

Evidence: `docs/testing/evidence/2026-10-02-core-runtime-node-suite.log` (committed).

## 4. Security invariants — status after Wave 2

| Invariant | Control (deterministic code + database) | Status |
|---|---|---|
| `duplicate_privileged_execution = 0` | `UNIQUE (idempotency_key)` + `ON CONFLICT DO NOTHING`, claimed before the side effect; two independent pools racing one key measured on real PostgreSQL 16 | **IMPLEMENTED_TESTED** |
| `high_risk_execution_without_approval = 0` | approval gate in `execute()` + append-only approval row (unique per proposal) | **IMPLEMENTED_TESTED** |
| `unauthorized_privileged_execution = 0` | authorization re-derived from the **persisted** role, never from the queue message | **IMPLEMENTED_TESTED** |
| `llm_raw_shell_execution = 0` | no executor path accepts a command string; raw-command fields fail proposal validation (catalog parity-tested against `llm-gateway`) | **IMPLEMENTED_TESTED** |
| `secret_leakage = 0` (audit ledger) | `redact()` in the audit writer + negative control that plants a secret in an executor error | **IMPLEMENTED_TESTED** |
| `cross_tenant_ticket/asset_access = 0` | tenant is persisted and scoped, but **no cross-tenant HTTP adversarial test yet** | **NOT_PRESENT** |

## 5. Verified seams present in source

> Presence in source ≠ verified at runtime. This section records existence only.

- PostgreSQL durable store adapter (legacy collections) — `internal-portal/src/postgres-adapter.js`
- Row-level governed lifecycle — `internal-portal/src/{action-catalog,action-lifecycle,lifecycle-store-postgres,lifecycle-store-memory}.js` + `internal-portal/migrations/001_action_lifecycle.sql`
- Worker bridge — `internal-portal/src/servicebus-bridge.js`
- Messaging module — `infra/terraform/modules/messaging/`

## 6. Open defects / documented gaps (carried, with source)

- **[helpdesk-capability-gaps]** — (1) no role-based access on portal routes, (2) no alert/ticket dedupe, (3) SLA is `slaPercent` only, no clock-based breach. *source: `docs/PORTFOLIO-COMPLETION-AUDIT-v2.md`*
- **[helpdesk-azure-boundary]** — the live footprint is narrow: `authMode: "lab"`, mock webhook. Any "live RBAC / durable approval" claim must restate it. *source: `docs/PORTFOLIO-FLAGSHIP-MATRIX.md`*
- **[wave2-boundaries]** — the durable store was exercised against **local PostgreSQL 16**, never Azure PostgreSQL; the governed pipeline is **not yet reachable over HTTP** (next Wave 2 step — not claimed here). *source: `docs/adr/0004-durable-action-lifecycle.md`*

## 7. NOT YET MEASURED (fail-closed)

- Azure live revision / image digest .... **UNMEASURED this pass**
- privilege separation / multi-replica behavior in Azure .... **UNMEASURED**
- cost exposure ......................... **UNMEASURED**
- governed lifecycle over HTTP ......... **NOT_PRESENT**
- cross-tenant adversarial control ..... **NOT_PRESENT**

CARRIED_FORWARD_NOT_REMEASURED (audit docs only): earlier local suite `137 passed / 0 failed`; restore-drill PASS on a `/tmp` fixture (AD part NOT_RUN). Do NOT quote as verified.

## 8. Hazards

- `$HOME` (`/Users/mainguyenbinhtan`) is a **DIRTY worktree** of `FlashSale-Backend`. `Projects/.git` is an **empty stub** → any git run from `Projects/` resolves to `$HOME`. **All git MUST use `git -C <abs repo path>`.**
- Concurrent writers (see §1): never `git add .`, never merge a branch that was not re-verified against the *current* `origin/main`.
- The transient Terraform plan embeds the configured placeholder password — deleted after each run, never committed.
