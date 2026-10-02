# =============================================================================
#  Root composition — Enterprise IT Helpdesk Lab
#
#  One-to-one with ../main.bicep: network → observability → key vault →
#  database → messaging → container app. Modules are repo-local
#  (./modules/*); no cross-repository module dependency (ROADMAP contract 18).
# =============================================================================

locals {
  # Mirrors Bicep `take(replace(nameSuffix, '-', ''), 21)` without substr()
  # out-of-range errors on short suffixes.
  name_suffix_compact = replace(var.name_suffix, "-", "")
  key_vault_name      = "kv-${substr(local.name_suffix_compact, 0, min(21, length(local.name_suffix_compact)))}"

  network = {
    vnet_name = "vnet-${var.name_suffix}"
  }

  observability = {
    workspace_name = "log-${var.name_suffix}"
    app_insights   = "appi-${var.name_suffix}"
  }

  database = {
    server_name = "psql-${var.name_suffix}"
  }

  messaging = {
    namespace_name = "sb-${var.name_suffix}"
  }

  apps = {
    environment_name = "cae-${var.name_suffix}"
    container_app    = "ca-helpdesk-portal"
  }
}

# 1. Virtual Network (infra / ACA / private endpoints subnets)
module "network" {
  source = "./modules/network"

  location            = var.location
  resource_group_name = var.resource_group_name
  environment_name    = var.environment_name
  vnet_name           = local.network.vnet_name
}

# 2. Observability (Log Analytics + Application Insights)
module "observability" {
  source = "./modules/observability"

  location            = var.location
  resource_group_name = var.resource_group_name
  environment_name    = var.environment_name
  workspace_name      = local.observability.workspace_name
  app_insights_name   = local.observability.app_insights
}

# 3. Key Vault (RBAC authorization only + irreversible purge protection)
module "keyvault" {
  source = "./modules/keyvault"

  location            = var.location
  resource_group_name = var.resource_group_name
  tenant_id           = var.tenant_id
  environment_name    = var.environment_name
  key_vault_name      = local.key_vault_name
}

# 4. PostgreSQL Flexible Server (durable truth for approvals + audit)
module "database" {
  source = "./modules/database"

  location               = var.location
  resource_group_name    = var.resource_group_name
  environment_name       = var.environment_name
  server_name            = local.database.server_name
  administrator_login    = "helpdeskadmin"
  administrator_password = var.postgres_admin_password
  postgres_version       = var.postgres_version
  sku_name               = var.postgres_sku_name
  storage_mb             = var.postgres_storage_mb
  backup_retention_days  = var.postgres_backup_retention_days
  public_network_access  = true
}

# 5. Service Bus Standard (queue-driven automation + dead lettering)
module "messaging" {
  source = "./modules/messaging"

  location            = var.location
  resource_group_name = var.resource_group_name
  environment_name    = var.environment_name
  namespace_name      = local.messaging.namespace_name
  queue_name          = var.servicebus_queue_name
}

# 6. Azure Container App (portal ingress, probes, autoscale)
module "apps" {
  source = "./modules/apps"

  location                       = var.location
  resource_group_name            = var.resource_group_name
  environment_name               = var.environment_name
  managed_environment_name       = local.apps.environment_name
  container_app_name             = local.apps.container_app
  container_image                = var.container_image
  infrastructure_subnet_id       = module.network.aca_subnet_id
  key_vault_uri                  = module.keyvault.key_vault_uri
  app_insights_connection_string = module.observability.app_insights_connection_string
  log_analytics_workspace_id     = module.observability.workspace_id
  min_replicas                   = var.container_app_min_replicas
  max_replicas                   = var.container_app_max_replicas
  container_cpu                  = var.container_app_cpu
  container_memory               = var.container_app_memory
}
