# =============================================================================
#  Module: database — parity with infra/modules/database/postgres.bicep
#
#  Durable truth for approvals, execution state and audit (ADR-0002).
#  Invariants: require_secure_transport = ON, auto-grow enabled, no geo-redundant
#  backup, HA disabled (single-region portfolio footprint).
# =============================================================================

locals {
  tags = {
    env       = var.environment_name
    project   = "helpdesk"
    managedBy = "terraform"
  }
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = var.server_name
  resource_group_name           = var.resource_group_name
  location                      = var.location
  version                       = var.postgres_version
  administrator_login           = var.administrator_login
  administrator_password        = var.administrator_password
  sku_name                      = var.sku_name
  storage_mb                    = var.storage_mb
  auto_grow_enabled             = true
  backup_retention_days         = var.backup_retention_days
  geo_redundant_backup_enabled  = false
  public_network_access_enabled = var.public_network_access

  # Parity note: the Bicep module sets highAvailability.mode = 'Disabled'.
  # azurerm has no "Disabled" value — HA-off is expressed by omitting the
  # high_availability block entirely, which is the same Azure end state.
  # Enabling HA (Phase 10/11) means adding `high_availability { mode = "ZoneRedundant" }`.

  tags = local.tags

  # Phase 3 gate: durable truth must never be replaced/destroyed by a plan.
  lifecycle {
    prevent_destroy = true
  }
}

# Invariant: TLS enforced for every connection.
resource "azurerm_postgresql_flexible_server_configuration" "require_secure_transport" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "ON"
}

resource "azurerm_postgresql_flexible_server_database" "helpdesk" {
  name      = var.database_name
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# Parity with the Bicep module: allow Azure internal services.
# Phase 4 replaces this with a private endpoint + private DNS.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "AllowAllWindowsAzureIps"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}
