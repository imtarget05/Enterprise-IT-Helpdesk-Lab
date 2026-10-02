# Remote state for Helpdesk validation — PARTIAL CONFIG, no credential values.
#
#   terraform init -reconfigure -backend-config=environments/validation/backend.hcl
#
# This repository's OWN state identity. It shares nothing with MAIA, AKS-SRE or
# Factory: separate resource group, separate storage account, separate key. The
# separation is the point — a typo here must not be able to reach another
# project's canonical state, and a typo there must not reach this one.
#
# `use_azuread_auth = true` and no `use_oidc`; see versions.tf for why a static
# OIDC flag is wrong for a shared, committed config.
resource_group_name  = "rg-helpdesk-tfstate"
storage_account_name = "sthdhelpdesk"
container_name       = "tfstate"
key                  = "helpdesk/validation.terraform.tfstate"

use_azuread_auth = true