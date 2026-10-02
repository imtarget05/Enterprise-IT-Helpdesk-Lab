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
#  State is NOT local durable truth: Phase 2 adds the Azure Storage remote
#  backend + GitHub OIDC. Until then `backend "local"` is the default and is
#  declared explicitly so a missing backend is a visible decision, never an
#  accident.
# =============================================================================

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
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
