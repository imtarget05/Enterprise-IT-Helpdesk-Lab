output "server_id" {
  description = "PostgreSQL server resource ID."
  value       = azurerm_postgresql_flexible_server.main.id
}

output "server_name" {
  description = "PostgreSQL server name."
  value       = azurerm_postgresql_flexible_server.main.name
}

output "server_fqdn" {
  description = "PostgreSQL server FQDN."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "database_name" {
  description = "Primary database name."
  value       = azurerm_postgresql_flexible_server_database.helpdesk.name
}
