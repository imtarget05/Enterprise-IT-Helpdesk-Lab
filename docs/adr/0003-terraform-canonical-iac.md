# ADR-0003: Terraform becomes the canonical IaC language (Phase 1)

- **Status:** Accepted
- **Date:** 2026-10-02
- **Supersedes:** nothing (transitions the IaC implementation)
- **Related:** [`docs/enterprise-target/ROADMAP.md`](../enterprise-target/ROADMAP.md) (Phase 1), [`infra/terraform/README.md`](../../infra/terraform/README.md)

## Context

The repository ships its Azure platform in Bicep (`infra/main.bicep` + 6 modules,
ADR-0002). The Enterprise Target program selects **Terraform** as the canonical
IaC language (ROADMAP Phase 1), for three reasons:

1. `terraform test` gives a native, mock-provider test framework with
   plan/apply semantics — Bicep has no equivalent.
2. `terraform show -json` gives a machine-readable plan that controls can
   gate on (key-vault purge protection, no-destroy, no-secret-leak).
3. Subsequent phases (remote state, OIDC, import, policy-as-code) standardize
   on Terraform in the industry and in this program.

## Decision

1. **Port 1:1.** `infra/terraform/` mirrors `infra/main.bicep` (6 modules,
   same params, same defaults, same resource shape) with two documented,
   reviewable divergences only:
   - `name_suffix` is an explicit input (Bicep's `uniqueString()` cannot be
     reproduced outside ARM);
   - `high_availability` "Disabled" is expressed by omitting the azurerm
     block (azurerm has no `Disabled` value; same Azure end state).
2. **Bicep is frozen.** Bicep stays compilable (CI `iac-validate.yml` still
   runs) but its content is pinned by SHA-256
   (`infra/FROZEN.lock.json` + `check_bicep_frozen.py`). Regeneration requires
   an explicit decision recorded here (a new ADR).
3. **State is explicit.** `terraform init -backend=false` until Phase 2 lands
   the Azure Storage remote backend — a missing backend is a visible decision,
   never an accident.
4. **No apply yet.** Phase 1 ends at a verified, gated, read-only plan.
   Apply/import belong to Phase 2/3.

## Consequences

- **Positive:** one deployable path; mocked `terraform test` (13 runs) and
  Python controls (130 parity + 13 plan + freeze) gate every change.
- **Negative:** two IaC languages coexist (frozen Bicep + canonical Terraform)
  until the final freeze removes or archives Bicep (Phase 12).
- **Risk acknowledged:** provider behavior (e.g. ACA subnet-width validation)
  can only be settled against the live environment; Phase 1 deliberately
  plans but does not apply.
