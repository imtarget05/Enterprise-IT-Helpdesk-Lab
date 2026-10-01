output "workspace_id" {
  description = "Log Analytics workspace resource ID."
  value       = azurerm_log_analytics_workspace.main.id
}

output "workspace_name" {
  description = "Log Analytics workspace name."
  value       = azurerm_log_analytics_workspace.main.name
}

output "app_insights_id" {
  description = "Application Insights component ID."
  value       = azurerm_application_insights.main.id
}

# Sensitive by contract: passed into the apps module, never exported at root.
output "app_insights_connection_string" {
  description = "Application Insights connection string (secret-bearing)."
  value       = azurerm_application_insights.main.connection_string
  sensitive   = true
}

output "app_insights_instrumentation_key" {
  description = "Application Insights instrumentation key (secret-bearing)."
  value       = azurerm_application_insights.main.instrumentation_key
  sensitive   = true
}
