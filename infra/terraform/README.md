# Terraform — Enterprise IT Helpdesk Lab (canonical IaC, Phase 1)

Terraform is the deployable path. Bicep under `infra/` is **FROZEN**
(parity source of truth, compiler-checked) — see
[`FROZEN.lock.json`](../FROZEN.lock.json) and
[`scripts/check_bicep_frozen.py`](scripts/check_bicep_frozen.py).

## Layout

```text
infra/terraform/
├── main.tf / variables.tf / outputs.tf / versions.tf   # root composition
├── env/{dev,prod}.tfvars                                # per-env values
├── modules/{network,keyvault,database,messaging,observability,apps}/
├── tests/{root,modules}.tftest.hcl                      # 13 mocked runs
├── fixtures/plan-ok.json                               # control-proof plan JSON
├── scripts/
│   ├── check_bicep_frozen.py                            # "Bicep frozen" control
│   ├── check_parity.py + parity-manifest.json           # Bicep↔TF parity control
│   ├── check_plan_invariants.py                         # plan-JSON control
│   ├── mutation-evidence.sh                             # re-runs M1–M5
│   └── tests/test_controls.py                           # 29 control bite tests
└── README.md (this file)
```

## Gates (what each proves)

| Gate | How | Offline? |
|---|---|---|
| `terraform validate` + `fmt` | static validity + canonical formatting | ✅ |
| `terraform test` (13 runs) | parity values, module wiring, input validation, 5 negative controls | ✅ mocked provider, zero Azure calls |
| `scripts/tests` (29 tests) | every control above FAILS when mutated | ✅ stdlib unittest |
| `check_bicep_frozen.py` | no Bicep file changed since Phase 1 | ✅ SHA-256 lock |
| `check_parity.py` (130 checks) | Bicep and Terraform describe the same platform + secrets marked sensitive | ✅ |
| `check_plan_invariants.py` (13 checks) | the rendered plan keeps every invariant + leaks no credential-shaped literal | ✅ on fixture; 🔑 on real plan |
| `.github/workflows/terraform-validate.yml` | runs 1–6 on every push/PR; real plan only when `AZURE_OIDC_ENABLED=true` (Phase 2+) | — |

## Local runbook (no Azure needed)

```bash
cd infra/terraform
terraform init -backend=false          # providers only, no state (Phase 2)
terraform fmt -check -recursive
terraform validate
terraform test                         # 13/13 expected
python3 -m unittest discover -s scripts/tests
python3 scripts/check_bicep_frozen.py --repo-root ../..
python3 scripts/check_parity.py --repo-root ../..
python3 scripts/check_plan_invariants.py fixtures/plan-ok.json
bash scripts/mutation-evidence.sh      # M1–M5 must each fail terraform test
```

## Real plan (read-only; Phase 1 verified this once, evidence below)

```bash
export ARM_USE_CLI=true
export ARM_SUBSCRIPTION_ID='$(az account show --query id -o tsv)'
terraform plan -refresh=false -var-file=env/dev.tfvars -out=/tmp/tfplan
terraform show -json /tmp/tfplan > /tmp/plan.json
python3 scripts/check_plan_invariants.py /tmp/plan.json                      # 13/13
python3 scripts/check_plan_invariants.py /tmp/plan.json \
  --forbid-value "$(grep -oP 'postgres_admin_password = "\K[^"]+' env/dev.tfvars)"
rm -f /tmp/tfplan /tmp/plan.json      # NEVER commit: plan JSON embeds the input
```

## What was proven in Phase 1 (read-only, 2026-10-02)

| Evidence | Result |
|---|---|
| `terraform plan` (dev tfvars, local `az login`, nothing applied) | `Plan: 15 to add, 0 to change, 0 to destroy` |
| plan-JSON control on the REAL plan | 13/13 PASS |
| `--forbid-value <dev placeholder>` on the REAL plan | 3 findings at the exact JSON paths of the password (proves the leak control reads real Terraform output, values redacted) |
| `mutation-evidence.sh` M1–M5 | each fails the intended `terraform test` assertion |
| `docs/testing/evidence/2026-10-02-terraform-phase1-mutation.log` | committed proof |
| Azure inventory before/after | unchanged (no resource created, read-only run) |

## Honest boundaries (must restate in any claim)

- **Not applied.** No `terraform apply` has run; nothing in Azure was created by
  Terraform. Live resources predate this port (see `docs/evidence/azure/`).
- **Not imported.** Backend state does not exist yet; Phase 2 (remote state +
  OIDC) and Phase 3 (import) are separate, required phases.
- **Passwords in plans.** `terraform show -json` always embeds configured
  sensitive inputs. Plan artifacts are transient and are never committed;
  the committed fixture contains no real credential (zero-GUID tenant,
  placeholder-style literals only in tfvars, never in the fixture).
- **Names are parameters, not hashes.** Bicep derives `nameSuffix` from
  `uniqueString(resourceGroup().id)`; Terraform takes an explicit `name_suffix`
  (dev: `helpdesk-dev`, prod: `helpdesk-prod`). Same shape, different naming.
- **ACA subnet width.** Bicep uses /23 (Azure's documented ACA minimum);
  azurerm documents /21+. Reconcile against the live environment in Phase 3/4
  before any apply — do not silently resize here.
