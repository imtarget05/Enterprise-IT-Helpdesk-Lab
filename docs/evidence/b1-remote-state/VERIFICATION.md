# Helpdesk — remote Terraform state foundation (B1)

```text
verified_at : 2026-10-02
status      : REMOTE_BACKEND = VERIFIED_LIVE
```

## What was wrong

This Terraform root had **no backend block at all**. That is worse than a wrong
one: `terraform init` succeeded, and the first `apply` would have written state
to a laptop `.tfstate` that no other operator could read. It fails silently, and
every static check stays green while it happens.

The fix copies MAIA's *pattern* — partial backend, Entra auth, shared key
disabled — and none of MAIA's *resources*. This repository owns
`rg-helpdesk-tfstate` / `sthdhelpdesk` / `tfstate`, with its own state key.

## What exists now

| Field | Value |
|---|---|
| State resource group | `rg-helpdesk-tfstate` (southeastasia, tags project=helpdesk) |
| Storage account | `sthdhelpdesk` (Standard_LRS, StorageV2, TLS1_2) |
| HTTPS only / anonymous blob | `true` / `false` |
| Shared key access | **disabled** (`allowSharedKeyAccess` = null) |
| Container | `tfstate`, reachable with `--auth-mode login`, no account key |
| State key | `helpdesk/validation.terraform.tfstate` |
| Operator Blob role | `Storage Blob Data Contributor` @ **storage account** scope |
| Local authoritative state | none |

## Proof

```text
terraform init -reconfigure -backend-config=environments/validation/backend.hcl
  -> Successfully configured the backend "azurerm"
terraform validate -> Success!

state blob via Blob API (Entra): helpdesk/validation.terraform.tfstate
ls *.tfstate       -> nothing
```

## Plan could NOT be produced — and why that is not a state problem

```text
terraform plan -> Error: No value for required variable (variables.tf:30)
```

The backend initialised and `validate` passed. The plan fails because this
repository has **no `environments/*/terraform.tfvars`** supplying required
variables (`resource_group_name`, `location`, `tenant_id`, `postgres_*`,
`servicebus_*`, …). That is a missing-inputs problem in the application
configuration, entirely separate from B1.

It is recorded here rather than papered over, because "plan produced" would be
the natural next claim and it would be false. Supplying the tfvars is
application-configuration work, not state-foundation work.

`PROD_STATE = TARGET_ONLY / NOT_CREATED` — only `validation` was created.

## Controls

`infra/terraform/tests/probe_backend_isolation.py` — rules S1–S8, each with a
negative control. S5 forbids naming any other portfolio project's state
resources (MAIA's and AKS-SRE's included). S8 is proven by **running**
`terraform init` in a throwaway copy with the backend config removed and
requiring a non-zero exit — it cannot be a grep, because the failure it prevents
(a silent fallback to local state) is exactly the one every other rule misses.

## Network and cost

Public network access is **enabled on purpose**: GitHub-hosted runners have no
stable outbound IP to allow-list. Recorded as
`PUBLIC_NETWORK_REACHABLE + ENTRA_AUTH_REQUIRED + SHARED_KEY_DISABLED`, not as
private-endpoint protection.

The storage account **can incur small ongoing cost**. It is **not** a
compute-quota consumer. It is permanent: transient application teardown must
never destroy it.

## CI OIDC

```text
CI_OIDC = NOT_CONFIGURED
```

No GitHub OIDC identity exists for this repository. B1 covered state foundation
only; the backend is already OIDC-compatible, so adding an identity later needs
no config change.

## Bootstrap

```bash
./scripts/bootstrap_state.sh --dry-run          # intent, zero mutation
ALLOW_AZURE_MUTATION=1 ./scripts/bootstrap_state.sh
```

Idempotent. Preflights the storage account name (Azure names are globally
unique) and accepts `allowSharedKeyAccess = null` as disabled, which is how
Azure reports it.