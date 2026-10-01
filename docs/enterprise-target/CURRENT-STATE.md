# CURRENT STATE — Enterprise-IT-Helpdesk-Lab

```text
measured_at : 2026-10-01
method      : read-only (git + filesystem). Azure NOT probed. Test suites NOT run.
mutations   : `git fetch --all --prune` only (remote-tracking refs; working tree untouched)
rule        : no number appears below unless it was measured here, or is explicitly
              labelled CARRIED_FORWARD_NOT_REMEASURED.
```

## 1. Identity

| Field | Value |
|---|---|
| remote | `https://github.com/imtarget05/Enterprise-IT-Helpdesk-Lab.git` |
| **canonical ref (`origin/main`)** | `a235165` (post-cleanup; the CD image-digest commit on top of the cleanup merge `f976d9b`) |
| local `HEAD` | not canonical — see drift row |
| drift vs origin | `origin/main` is canonical; local `main` is stale and must not be quoted |
| worktree | **CLEAN** |
| Render purge | **DONE** — `internal-portal/render.yaml` + `.github/workflows/keepalive.yml` deleted in PR #1 (merge `f976d9b`); anti-Render gate `internal-portal/python-portal/tests/test_hygiene_no_render.py` (5 tests) merged; `origin/main` tree has **zero** `render.yaml`/`keepalive*` artifacts |

**Prior blocker RESOLVED:** this ledger previously recorded the branch as DIVERGENT from `origin/main` (`+2 ahead / −1 behind`). That divergence is closed — the Render cleanup landed through PR #1 and `origin/main` is reconciled. CI on the cleanup merge was **green** (run `36915930137`, 12/12 jobs; `origin/main` push run `36916520333` also green). CI-measured python-portal suite: **90 tests OK** (85 baseline + 5 anti-Render gate).

## 2. Infrastructure as deployed today

| Field | Value |
|---|---|
| IaC language | **Bicep** (Terraform: **NOT PRESENT** — 0 `*.tf` files) |
| entrypoints | `infra/main.bicep` |
| modules | `infra/modules/{apps,database,keyvault,messaging,network,observability}` |
| parameters | `infra/parameters/{dev,prod}.bicepparam` |
| invariant checker | `infra/check_invariants.py` |
| validation | `infra/validate.sh`, `infra/bicepconfig.json` |
| CI | `.github/workflows/iac-validate.yml` *(also: `ci.yml`, `ci-live.yml`, `build-container.yml`, `llm-gateway.yml`; `keepalive.yml` removed in the Render cleanup)* |

## 3. Verified seams present in source

> Presence in source ≠ verified at runtime. This section records existence only.

- PostgreSQL durable store adapter — `internal-portal/src/postgres-adapter.js` (uses `pg.Pool`)
- Adapter test — `internal-portal/test/postgres-adapter.test.js`
- Messaging module (`messaging/`) present in Bicep (Service Bus seam)

## 4. Open defects / documented gaps (carried, with source)

- **[helpdesk-capability-gaps]** — documented capability gaps, not blockers: (1) no role-based access on portal routes, (2) no alert/ticket dedupe, (3) SLA is `slaPercent` only, no clock-based breach. *source: `docs/PORTFOLIO-COMPLETION-AUDIT-v2.md`*
- **[helpdesk-azure-boundary]** — the live footprint is narrow: `authMode: "lab"`, mock webhook, no credential in the probe. Any "live RBAC / durable approval" claim must state this boundary. *source: `docs/PORTFOLIO-FLAGSHIP-MATRIX.md`*

## 5. NOT YET MEASURED (fail-closed)

- test suite @ `origin/main` ............ **UNMEASURED**
- CI status @ `origin/main` ............. **UNMEASURED**
- Azure live revision / image digest .... **UNMEASURED**
- privilege separation / multi-replica behavior .... **UNMEASURED**
- cost exposure ......................... **UNMEASURED**

CARRIED_FORWARD_NOT_REMEASURED (audit docs only): earlier local suite `137 passed / 0 failed`; restore-drill PASS on a `/tmp` fixture (AD part NOT_RUN). Do NOT quote as verified.

## 6. Hazards

- `$HOME` (`/Users/mainguyenbinhtan`) is a **DIRTY worktree** of `FlashSale-Backend`. `Projects/.git` is an **empty stub** → any git run from `Projects/` resolves to `$HOME`. **All git MUST use `git -C <abs repo path>`.**
- Branch divergence (see §1) — measure/freeze only after reconciliation.
