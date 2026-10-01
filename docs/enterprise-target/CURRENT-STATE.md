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
| **canonical ref (`origin/main`)** | `f9dab7dfb0538f7730079ad0e67890a001a60c11` |
| local `HEAD` | `f8f5fed3c036c75768eeb788c1ebcff76f9f189d` (branch `main`) |
| drift vs origin | **DIVERGENT: +2 ahead / −1 behind** |
| worktree | **CLEAN** |

**Blocker before freezing this baseline:** the branch has **diverged** from `origin/main`. The pushed commit `f9dab7d` (`chore: record portal image digest for 3711ddc…`) is *not* in the local tree. Any ledger built on local `HEAD` alone is incomplete. Reconcile (rebase/merge) before Phase 1.

## 2. Infrastructure as deployed today

| Field | Value |
|---|---|
| IaC language | **Bicep** (Terraform: **NOT PRESENT** — 0 `*.tf` files) |
| entrypoints | `infra/main.bicep` |
| modules | `infra/modules/{apps,database,keyvault,messaging,network,observability}` |
| parameters | `infra/parameters/{dev,prod}.bicepparam` |
| invariant checker | `infra/check_invariants.py` |
| validation | `infra/validate.sh`, `infra/bicepconfig.json` |
| CI | `.github/workflows/iac-validate.yml` *(also: `ci.yml`, `ci-live.yml`, `build-container.yml`, `keepalive.yml`, `llm-gateway.yml`)* |

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
