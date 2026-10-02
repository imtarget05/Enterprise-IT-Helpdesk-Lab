# =============================================================================
#  Terraform — Enterprise IT Helpdesk Lab (canonical IaC as of Phase 1)
#
#  Bicep has been DELETED from this repository. infra/terraform/ is now the only
#  infrastructure source of truth, and the Bicep↔Terraform parity control and the
#  Bicep freeze lock that used to police it are gone with it. That control was the
#  only independent check that this port matched the stack it replaced; from here
#  the guards are `terraform validate`, the `terraform test` contract assertions
#  and the plan-invariant checks.
#
#  State is NOT local durable truth. Until Phase 2 this root had no backend
#  block at all, which meant the first `terraform init` succeeded and state was
#  written to a laptop `.tfstate` that no other operator could read — a silent
#  failure that every static check stayed green through.
#
#  The backend is now a PARTIAL azurerm block; environments/<env>/backend.hcl
#  supplies the values. Authentication is Entra ID only, and is per-environment:
#
#     local : `az login` (use_azuread_auth = true in backend.hcl)
#     CI    : ARM_USE_OIDC=true ARM_USE_AZUREAD_AUTH=true + ARM_CLIENT_ID /
#             ARM_TENANT_ID / ARM_SUBSCRIPTION_ID
#
#  `use_oidc` is deliberately NOT committed here or in any backend.hcl: a
#  static value forces the GitHub Actions OIDC path, which reads
#  ACTIONS_ID_TOKEN_REQUEST_TOKEN and therefore breaks a local `az login` init.
#  tests/probe_backend_isolation.py fails the build if it is ever hardcoded back.
# =============================================================================

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  backend "azurerm" {}
}

provider "azurerm" {
  features {}

  # Credential-free CI (`terraform validate` / `terraform test`) never configures
  # a real provider. Any plan/apply path must select an auth mode explicitly:
  #   ARM_USE_OIDC=true  → Phase 2 GitHub OIDC (preferred)
  #   ARM_USE_CLI=true   → local operator with `az login`
  # NEVER `ARM_CLIENT_SECRET` (Phase 2 gate: no client secret anywhere).
  #
  # Keep the deprecated `features {}` empty: pinned via
  # resource_provider_registrations = "none" below so `plan`/`validate` never
  # mutate subscription-level provider registrations.
  resource_provider_registrations = "none"
}
