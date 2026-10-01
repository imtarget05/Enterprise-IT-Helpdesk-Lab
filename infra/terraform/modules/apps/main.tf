# =============================================================================
#  Module: apps — parity with infra/modules/apps/portal.bicep
#
#  Portal Container App + its Container App Environment.
#
#  Boundary notes that any claim must restate:
#   · ingress is EXTERNAL (parity with the Bicep module: `external: true`).
#   · the container runs with a SYSTEM-ASSIGNED managed identity; no credential
#     is placed in the template, and no registry credential is declared.
#   · the Application Insights connection string is a sensitive variable: it is
#     injected as an environment variable and never exported.
#   · azurerm documents `infrastructure_subnet_id` as requiring /21 or larger;
#     the Bicep module (and this port, for parity) uses /23. Azure's ACA VNet
#     injection minimum is /23. Reconcile against the live environment before
#     any apply in Phase 3/4 rather than silently resizing the subnet here.
# =============================================================================

locals {
  tags = {
    env       = var.environment_name
    project   = "helpdesk"
    managedBy = "terraform"
  }
}

resource "azurerm_container_app_environment" "main" {
  name                           = var.managed_environment_name
  location                       = var.location
  resource_group_name            = var.resource_group_name
  infrastructure_subnet_id       = var.infrastructure_subnet_id != "" ? var.infrastructure_subnet_id : null
  internal_load_balancer_enabled = false
  log_analytics_workspace_id     = var.log_analytics_workspace_id != "" ? var.log_analytics_workspace_id : null

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  tags = local.tags
}

resource "azurerm_container_app" "main" {
  name                         = var.container_app_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type = "SystemAssigned"
  }

  ingress {
    external_enabled           = true
    target_port                = var.target_port
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "helpdesk-portal"
      image  = var.container_image
      cpu    = var.container_cpu
      memory = var.container_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "PORT"
        value = tostring(var.target_port)
      }

      env {
        name  = "KEY_VAULT_URI"
        value = var.key_vault_uri
      }

      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = var.app_insights_connection_string
      }

      liveness_probe {
        path             = "/api/health"
        port             = var.target_port
        transport        = "HTTP"
        initial_delay    = 15
        interval_seconds = 30
      }

      readiness_probe {
        path             = "/api/health"
        port             = var.target_port
        transport        = "HTTP"
        initial_delay    = 5
        interval_seconds = 15
      }
    }
  }
}
