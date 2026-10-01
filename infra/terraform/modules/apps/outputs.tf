output "environment_id" {
  description = "Container App Environment resource ID."
  value       = azurerm_container_app_environment.main.id
}

output "container_app_id" {
  description = "Container App resource ID."
  value       = azurerm_container_app.main.id
}

output "container_app_principal_id" {
  description = "System-assigned managed identity principal ID."
  value       = azurerm_container_app.main.identity[0].principal_id
}

output "app_fqdn" {
  description = "Public FQDN of the Container App ingress."
  value       = azurerm_container_app.main.ingress[0].fqdn
}
