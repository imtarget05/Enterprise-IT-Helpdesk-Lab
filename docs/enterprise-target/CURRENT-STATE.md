# CURRENT STATE — Enterprise-IT-Helpdesk-Lab

```text
measured_at : 2026-10-02
method      : read-only for Azure (plan only); local suites re-run.
mutations   : none against the working tree (fetch of remote refs only)
rule        : no number appears below unless it was measured here, or is explicitly
              labelled CARRIED_FORWARD_NOT_REMEASURED.
```

## 1. Identity

| Field | Value |
|---|---|
| remote | `https://github.com/imtarget05/Enterprise-IT-Helpdesk-Lab.git` |
| **canonical ref (`origin/main`)** | `a235165` (post-cleanup; the CD image-digest commit on top of the cleanup merge `f976d9b`) |
| local `HEAD` | branch `main` — **2 behind / 1 ahead** of `origin/main` (local work is unpushed; `origin/main` is canonical) |
| drift vs origin | `origin/main` is canonical; local `main` is stale and must not be quoted |
| worktree | **CLEAN** |
| Render purge | **DONE** — `internal-portal/render.yaml` + `.github/workflows/keepalive.yml` deleted in PR #1 (merge `f976d9b`); anti-Render gate `tests/test_hygiene_no_render.py` (5 tests) merged; `origin/main` tree has **zero** `render.yaml`/`keepalive*` artifacts |

## 2. Infrastructure as deployed today

| Field | Value |
|---|---|
| IaC language | **Terraform (canonical, `infra/terraform/`)**; Bicep **FROZEN** (`infra/FROZEN.lock.json`, 10 files) |
| entrypoints | `infra/terraform/main.tf` · `infra/main.bicep` (frozen parity source) |
| modules | `infra/terraform/modules/{network,keyvault,database,messaging,observability,apps}` |
| parameters | `infra/terraform/env/{dev,prod}.tfvars` (parity with `infra/parameters/*.bicepparam`) |
| invariant checkers | `infra/check_invariants.py` (ARM JSON) · `infra/terraform/scripts/{check_bicep_frozen,check_parity,check_plan_invariants}.py` |
| validation | `infra/validate.sh`, `infra/bicepconfig.json`, `terraform validate` + `terraform test` |
| CI | `.github/workflows/{ci.yml,ci-live.yml,iac-validate.yml,terraform-validate.yml,build-container.yml,keepalive.yml,llm-gateway.yml}` |

## 3. Measured this pass (2026-10-02)

| Suite | Command | Result |
|---|---|---|
| Node portal | `cd internal-portal && npm test` | **343 tests — 342 pass, 1 skipped, 0 fail** |
| API smoke | `cd internal-portal && ./test-api.sh` | **68/68 pass (100.0%)** |
| Python services | pytest on python-portal + llm-gateway | **156 passed, 4 xfailed** |
| IaC validate (Bicep) | `bash infra/validate.sh` | **ALL CHECKS PASSED** (16/16 traversal contracts, 2/2 invariants) |
| Terraform | `terraform test` (azurerm 4.81.0, mocked) | **13/13 passed** |
| Control bite tests | `python3 -m unittest discover -s infra/terraform/scripts/tests` | **29/29 passed** |
| Bicep freeze | `check_bicep_frozen.py` | 10/10 digests match |
| Bicep↔Terraform parity | `check_parity.py` | **130/130 hold** |
| Plan invariants (fixture) | `check_plan_invariants.py fixtures/plan-ok.json` | **13/13 hold** |
| Plan invariants (REAL plan) | read-only `terraform plan` + control on `show -json` | **13/13 hold** (`15 to add, 0 to change, 0 to destroy`) |
| Leak control (REAL plan) | same plan + `--forbid-value <password>` | **3 findings at exact JSON paths** (values redacted) |
| Terraform mutations | `scripts/mutation-evidence.sh` M1–M5 | each fails the intended control |
| CI @ `origin/main` | `gh run view 36898127409` | **12/12 jobs green** |
| Azure inventory | `az resource list -g rg-portfolio-evidence` | 1 workspace, 1 ACA env, **4 container apps** |
| Helpdesk revision | `az containerapp revision list -n ca-helpdesk-portal` | **`--0000001` ACTIVE**, digest `sha256:d9eb0b9a…`, 1 replica |

> Presence in source ≠ verified at runtime. This section records existence only.

- PostgreSQL durable store adapter — `internal-portal/src/postgres-adapter.js` (uses `pg.Pool`)
- Adapter test — `internal-portal/test/postgres-adapter.test.js`
- Messaging module (`messaging/`) present in Bicep (Service Bus seam)
- Terraform parity port — `infra/terraform/` (ADR-0003)

## 4. Open defects / documented gaps (carried, with source)

- **[helpdesk-capability-gaps]** — documented capability gaps, not blockers: (1) no role-based access on portal routes, (2) no alert/ticket dedupe, (3) SLA is `slaPercent` only, no clock-based breach. *source: `docs/PORTFOLIO-COMPLETION-AUDIT-v2.md`*
- **[helpdesk-azure-boundary]** — the live footprint is narrow: `authMode: "lab"`, mock webhook, no credential in the probe. Any "live RBAC / durable approval" claim must state this boundary. *source: `docs/PORTFOLIO-FLAGSHIP-MATRIX.md`*
- **[phase1-boundaries]** — Terraform has never applied: no state, no import (Phase 2/3); plans are transient (passwords always embed in `show -json`) and uncommitted. *source: `infra/terraform/README.md`*

## 5. NOT YET MEASURED (fail-closed)

- test suite @ `origin/main` ............ **MEASURED (§3)**
- CI status @ `origin/main` ............. **MEASURED (§3)**
- Azure live revision / image digest .... **MEASURED read-only (§3)**
- privilege separation / multi-replica behavior .... **UNMEASURED**
- cost exposure ......................... **UNMEASURED**

CARRIED_FORWARD_NOT_REMEASURED (audit docs only): earlier local suite `137 passed / 0 failed`; restore-drill PASS on a `/tmp` fixture (AD part NOT_RUN). Do NOT quote as verified.

## 6. Hazards

- `$HOME` (`/Users/mainguyenbinhtan`) is a **DIRTY worktree** of `FlashSale-Backend`. `Projects/.git` is an **empty stub** → any git run from `Projects/` resolves to `$HOME`. **All git MUST use `git -C <abs repo path>`.**
- The transient Terraform plan embeds the configured dev password placeholder — deleted after each run, never committed.
