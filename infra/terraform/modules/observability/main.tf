# =============================================================================
#  Module: observability — parity with infra/modules/observability/main.bicep
#
#  Log Analytics (PerGB2018, resource-scoped log access) + Application Insights
#  bound to the workspace. Phase 7 layers OTel dashboards/SLO on top; this
#  module owns the ingestion endpoints only.
# =============================================================================

locals {
  tags = {
    env       = var.environment_name
    project   = "helpdesk"
    managedBy = "terraform"
  }
}

resource "azurerm_log_analytics_workspace" "main" {
  name                            = var.workspace_name
  location                        = var.location
  resource_group_name             = var.resource_group_name
  sku                             = "PerGB2018"
  retention_in_days               = var.log_retention_in_days
  allow_resource_only_permissions = true
  tags                            = local.tags
}

resource "azurerm_application_insights" "main" {
  name                       = var.app_insights_name
  location                   = var.location
  resource_group_name        = var.resource_group_name
  application_type           = "web"
  workspace_id               = azurerm_log_analytics_workspace.main.id
  internet_ingestion_enabled = true
  internet_query_enabled     = true
  tags                       = local.tags
}
