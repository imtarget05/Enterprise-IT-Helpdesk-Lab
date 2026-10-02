# =============================================================================
#  Root outputs — parity with ../main.bicep outputs, plus the identifiers the
#  later phases need (Phase 5 messaging, Phase 7 observability).
#
#  Contract (ROADMAP 13): no secret value may appear in an output. The
#  Application Insights connection string and the PostgreSQL password are
#  therefore passed *into* modules and never exported here. The control in
#  scripts/check_plan_invariants.py enforces this by name and by value scan.
# =============================================================================

output "resource_group_name" {
  description = "Resource group holding the platform (pre-existing, not managed here)."
  value       = var.resource_group_name
}

output "portal_fqdn" {
  description = "Public FQDN of the Helpdesk portal Container App."
  value       = module.apps.app_fqdn
}

output "container_app_id" {
  description = "Resource ID of the portal Container App."
  value       = module.apps.container_app_id
}

output "container_app_principal_id" {
  description = "System-assigned managed identity principal ID of the portal Container App."
  value       = module.apps.container_app_principal_id
}

output "postgres_fqdn" {
  description = "FQDN of the PostgreSQL Flexible Server."
  value       = module.database.server_fqdn
}

output "postgres_database_name" {
  description = "Primary Helpdesk database name."
  value       = module.database.database_name
}

output "service_bus_namespace" {
  description = "Service Bus namespace name."
  value       = module.messaging.namespace_name
}

output "service_bus_queue_name" {
  description = "Automation queue name (dead-letter + duplicate detection enabled)."
  value       = module.messaging.queue_name
}

output "key_vault_uri" {
  description = "Key Vault URI used by the portal container for secret references."
  value       = module.keyvault.key_vault_uri
}

output "key_vault_id" {
  description = "Key Vault resource ID."
  value       = module.keyvault.key_vault_id
}

output "key_vault_name" {
  description = "Key Vault name (parity with Bicep's take(replace(nameSuffix,'-',''),21) rule)."
  value       = module.keyvault.key_vault_name
}

output "log_analytics_workspace_id" {
  description = "Log Analytics workspace ID backing Application Insights."
  value       = module.observability.workspace_id
}

output "app_insights_id" {
  description = "Application Insights component resource ID."
  value       = module.observability.app_insights_id
}

output "vnet_id" {
  description = "Virtual network resource ID."
  value       = module.network.vnet_id
}

output "aca_subnet_id" {
  description = "Delegated subnet ID for Container Apps VNet injection."
  value       = module.network.aca_subnet_id
}

output "private_endpoints_subnet_id" {
  description = "Subnet reserved for private endpoints (Phase 4)."
  value       = module.network.private_endpoints_subnet_id
}
