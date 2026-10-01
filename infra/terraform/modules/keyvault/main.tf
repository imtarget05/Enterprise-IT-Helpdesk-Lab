# =============================================================================
#  Module: keyvault — parity with infra/modules/keyvault/main.bicep
#
#  Security invariants enforced here (asserted by
#  scripts/check_plan_invariants.py against a real plan JSON):
#    · purge_protection_enabled   == true
#    · rbac_authorization_enabled == true   (no access policies)
#    · soft_delete_retention_days >= 7
# =============================================================================

locals {
  tags = {
    env       = var.environment_name
    project   = "helpdesk"
    managedBy = "terraform"
  }
}

resource "azurerm_key_vault" "main" {
  name                          = var.key_vault_name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  tenant_id                     = var.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = var.soft_delete_retention_in_days
  public_network_access_enabled = true

  network_acls {
    bypass         = "AzureServices"
    default_action = "Allow"
  }

  tags = local.tags

  # Phase 3 gate: destroy of the secret store must be impossible by accident.
  lifecycle {
    prevent_destroy = true
  }
}
