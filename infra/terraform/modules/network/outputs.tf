output "vnet_id" {
  description = "Virtual network resource ID."
  value       = azurerm_virtual_network.main.id
}

output "vnet_name" {
  description = "Virtual network name."
  value       = azurerm_virtual_network.main.name
}

output "infra_subnet_id" {
  description = "Infrastructure subnet ID."
  value       = azurerm_subnet.infra.id
}

output "aca_subnet_id" {
  description = "Container Apps (delegated) subnet ID."
  value       = azurerm_subnet.aca.id
}

output "private_endpoints_subnet_id" {
  description = "Private endpoints subnet ID."
  value       = azurerm_subnet.private_endpoints.id
}
