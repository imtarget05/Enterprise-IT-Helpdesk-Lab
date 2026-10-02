# =============================================================================
#  Per-module tests — Enterprise IT Helpdesk Lab (Phase 1 gate)
#
#  Each run block plans ONE module in isolation with a mocked provider, so a
#  failure names exactly which module lost which invariant. These are the
#  static half of the parity gate; scripts/check_plan_invariants.py is the
#  dynamic half (it reads a real plan JSON).
#
#  Run: cd infra/terraform && terraform test
# =============================================================================

mock_provider "azurerm" {
  # The mocked workspace ID must exist at PLAN time so the Application Insights
  # binding can be asserted: without it `workspace_id` is unknown and any
  # condition over it is unevaluatable.
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.OperationalInsights/workspaces/log-mock"
      name = "log-mock"
    }
  }
}

# ---------------------------------------------------------------------------
# network
# ---------------------------------------------------------------------------
run "network_matches_vnet_bicep" {
  command = plan

  module {
    source = "./modules/network"
  }

  variables {
    location            = "southeastasia"
    resource_group_name = "rg-mock"
    environment_name    = "dev"
    vnet_name           = "vnet-mock"
  }

  assert {
    condition     = contains(azurerm_virtual_network.main.address_space, "10.10.0.0/16")
    error_message = "VNet address space must stay 10.10.0.0/16."
  }

  assert {
    condition     = contains(azurerm_subnet.infra.address_prefixes, "10.10.0.0/24")
    error_message = "snet-infra must stay 10.10.0.0/24."
  }

  assert {
    condition     = contains(azurerm_subnet.aca.address_prefixes, "10.10.2.0/23")
    error_message = "snet-aca must stay 10.10.2.0/23."
  }

  assert {
    condition     = azurerm_subnet.aca.delegation[0].service_delegation[0].name == "Microsoft.App/environments"
    error_message = "The ACA subnet MUST be delegated to Microsoft.App/environments or Container Apps cannot be VNet-injected."
  }

  assert {
    condition     = contains(azurerm_subnet.private_endpoints.address_prefixes, "10.10.4.0/24")
    error_message = "snet-private-endpoints must stay 10.10.4.0/24."
  }

  assert {
    condition     = azurerm_virtual_network.main.tags["managedBy"] == "terraform"
    error_message = "Tags must record the managing tool as terraform (Bicep is frozen)."
  }
}

# ---------------------------------------------------------------------------
# keyvault
# ---------------------------------------------------------------------------
run "keyvault_security_invariants" {
  command = plan

  module {
    source = "./modules/keyvault"
  }

  variables {
    location            = "southeastasia"
    resource_group_name = "rg-mock"
    tenant_id           = "11111111-1111-1111-1111-111111111111"
    environment_name    = "dev"
    key_vault_name      = "kv-mock"
  }

  assert {
    condition     = azurerm_key_vault.main.purge_protection_enabled == true
    error_message = "Key Vault purge protection MUST be enabled (irreversible secret loss otherwise)."
  }

  assert {
    condition     = azurerm_key_vault.main.rbac_authorization_enabled == true
    error_message = "Key Vault MUST use RBAC authorization; access policies are not allowed."
  }

  assert {
    condition     = azurerm_key_vault.main.soft_delete_retention_days == 90
    error_message = "Soft-delete retention must stay 90 days (parity with keyvault/main.bicep)."
  }

  assert {
    condition     = azurerm_key_vault.main.network_acls[0].bypass == "AzureServices"
    error_message = "Network ACL bypass must remain AzureServices."
  }

  assert {
    condition     = azurerm_key_vault.main.sku_name == "standard"
    error_message = "Key Vault SKU must stay standard."
  }
}

run "keyvault_rejects_invalid_name" {
  command = plan

  module {
    source = "./modules/keyvault"
  }

  variables {
    location            = "southeastasia"
    resource_group_name = "rg-mock"
    tenant_id           = "11111111-1111-1111-1111-111111111111"
    environment_name    = "dev"
    key_vault_name      = "1"
  }

  expect_failures = [var.key_vault_name]
}

# ---------------------------------------------------------------------------
# database
# ---------------------------------------------------------------------------
run "database_durability_invariants" {
  command = plan

  module {
    source = "./modules/database"
  }

  variables {
    location               = "southeastasia"
    resource_group_name    = "rg-mock"
    environment_name       = "dev"
    server_name            = "psql-mock"
    administrator_password = "NotARealPassword123!"
  }

  assert {
    condition     = azurerm_postgresql_flexible_server_configuration.require_secure_transport.value == "ON"
    error_message = "require_secure_transport MUST be ON."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.main.auto_grow_enabled == true
    error_message = "Storage auto-grow must be enabled so the durable store cannot fill up silently."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.main.sku_name == "B_Standard_B1ms"
    error_message = "SKU must stay burstable B_Standard_B1ms (parity with postgres.bicep)."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.main.storage_mb == 32768
    error_message = "Storage must stay 32 GB (32768 MB)."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.main.backup_retention_days == 7
    error_message = "Backup retention must stay 7 days."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.main.geo_redundant_backup_enabled == false
    error_message = "Geo-redundant backup must stay disabled (parity with postgres.bicep)."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server_database.helpdesk.name == "helpdesk"
    error_message = "The primary database must be named helpdesk."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server_firewall_rule.azure_services.name == "AllowAllWindowsAzureIps"
    error_message = "Firewall rule name must stay AllowAllWindowsAzureIps for import parity (Phase 3)."
  }
}

# ---------------------------------------------------------------------------
# messaging
# ---------------------------------------------------------------------------
run "messaging_exactly_once_primitives" {
  command = plan

  module {
    source = "./modules/messaging"
  }

  variables {
    location            = "southeastasia"
    resource_group_name = "rg-mock"
    environment_name    = "dev"
    namespace_name      = "sb-mock"
  }

  assert {
    condition     = azurerm_servicebus_namespace.main.sku == "Standard"
    error_message = "Service Bus SKU must stay Standard (duplicate detection needs Standard+)."
  }

  assert {
    condition     = azurerm_servicebus_namespace.main.minimum_tls_version == "1.2"
    error_message = "Service Bus must require TLS 1.2."
  }

  assert {
    condition     = azurerm_servicebus_queue.automation_jobs.requires_duplicate_detection == true
    error_message = "Duplicate detection MUST be on: Phase 5 exactly-once depends on it."
  }

  assert {
    condition     = azurerm_servicebus_queue.automation_jobs.dead_lettering_on_message_expiration == true
    error_message = "Dead-lettering on message expiration MUST be on."
  }

  assert {
    condition     = azurerm_servicebus_queue.automation_jobs.max_delivery_count == 10
    error_message = "max_delivery_count must stay bounded at 10."
  }

  assert {
    condition     = azurerm_servicebus_queue.automation_jobs.lock_duration == "PT5M"
    error_message = "lock_duration must stay PT5M so a crashed worker releases the message."
  }

  assert {
    condition     = azurerm_servicebus_queue.automation_jobs.duplicate_detection_history_time_window == "PT10M"
    error_message = "Duplicate detection window must stay PT10M."
  }
}

# ---------------------------------------------------------------------------
# observability
# ---------------------------------------------------------------------------
run "observability_ingestion_wiring" {
  # apply against a MOCKED provider: no Azure call is made, but computed
  # attributes are materialised so the App Insights → workspace binding is
  # provable. `plan` alone leaves them unknown.
  command = apply

  module {
    source = "./modules/observability"
  }

  variables {
    location            = "southeastasia"
    resource_group_name = "rg-mock"
    environment_name    = "dev"
    workspace_name      = "log-mock"
    app_insights_name   = "appi-mock"
  }

  assert {
    condition     = azurerm_log_analytics_workspace.main.sku == "PerGB2018"
    error_message = "Log Analytics SKU must stay PerGB2018."
  }

  assert {
    condition     = azurerm_log_analytics_workspace.main.retention_in_days == 30
    error_message = "Log retention must stay 30 days (parity with observability/main.bicep)."
  }

  assert {
    condition     = azurerm_log_analytics_workspace.main.allow_resource_only_permissions == true
    error_message = "Resource-scoped log access must stay enabled."
  }

  assert {
    condition     = azurerm_application_insights.main.application_type == "web"
    error_message = "Application Insights application_type must be web."
  }

  assert {
    condition     = azurerm_application_insights.main.workspace_id == azurerm_log_analytics_workspace.main.id
    error_message = "Application Insights MUST be bound to the Log Analytics workspace."
  }
}

# ---------------------------------------------------------------------------
# apps (portal)
# ---------------------------------------------------------------------------
run "apps_portal_runtime_contract" {
  command = plan

  module {
    source = "./modules/apps"
  }

  variables {
    location                   = "southeastasia"
    resource_group_name        = "rg-mock"
    environment_name           = "dev"
    managed_environment_name   = "cae-mock"
    container_app_name         = "ca-helpdesk-portal"
    container_image            = "ghcr.io/imtarget05/enterprise-it-helpdesk-lab-it-portal:dev"
    infrastructure_subnet_id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Network/virtualNetworks/vnet-mock/subnets/snet-aca"
    key_vault_uri              = "https://kv-mock.vault.azure.net/"
    log_analytics_workspace_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.OperationalInsights/workspaces/log-mock"
  }

  assert {
    condition     = azurerm_container_app.main.revision_mode == "Single"
    error_message = "Portal must use Single revision mode (idempotent redeploy, one live revision)."
  }

  assert {
    condition     = azurerm_container_app.main.ingress[0].external_enabled == true
    error_message = "Portal ingress must stay external (parity with portal.bicep)."
  }

  assert {
    condition     = azurerm_container_app.main.ingress[0].target_port == 3000
    error_message = "Ingress target port must be 3000."
  }

  assert {
    condition     = azurerm_container_app.main.ingress[0].allow_insecure_connections == false
    error_message = "Plain HTTP must not be allowed into the portal."
  }

  assert {
    condition     = azurerm_container_app.main.ingress[0].traffic_weight[0].percentage == 100
    error_message = "All traffic must be pinned to the latest revision (100%)."
  }

  assert {
    condition     = azurerm_container_app.main.identity[0].type == "SystemAssigned"
    error_message = "The portal must run with a system-assigned managed identity; no credential in the template."
  }

  assert {
    condition     = azurerm_container_app.main.template[0].min_replicas == 1 && azurerm_container_app.main.template[0].max_replicas == 3
    error_message = "Replica bounds must stay min=1 / max=3 (parity with portal.bicep)."
  }

  assert {
    condition     = azurerm_container_app.main.template[0].container[0].cpu == 0.5 && azurerm_container_app.main.template[0].container[0].memory == "1.0Gi"
    error_message = "Container sizing must stay 0.5 CPU / 1.0Gi."
  }

  assert {
    condition     = anytrue([for e in azurerm_container_app.main.template[0].container[0].env : e.name == "KEY_VAULT_URI" && e.value == "https://kv-mock.vault.azure.net/"])
    error_message = "KEY_VAULT_URI must be injected from the key vault module output."
  }

  assert {
    condition     = anytrue([for e in azurerm_container_app.main.template[0].container[0].env : e.name == "NODE_ENV" && e.value == "production"])
    error_message = "NODE_ENV must be production in a deployed environment."
  }

  assert {
    condition     = azurerm_container_app.main.template[0].container[0].liveness_probe[0].path == "/api/health"
    error_message = "Liveness probe must hit /api/health."
  }

  assert {
    condition     = azurerm_container_app.main.template[0].container[0].liveness_probe[0].initial_delay == 15
    error_message = "Liveness probe initial delay must stay 15s (parity with portal.bicep)."
  }

  assert {
    condition     = azurerm_container_app.main.template[0].container[0].readiness_probe[0].path == "/api/health"
    error_message = "Readiness probe must hit /api/health."
  }

  assert {
    condition     = azurerm_container_app.main.template[0].container[0].readiness_probe[0].initial_delay == 5
    error_message = "Readiness probe initial delay must stay 5s (parity with portal.bicep)."
  }

  assert {
    condition     = azurerm_container_app_environment.main.internal_load_balancer_enabled == false
    error_message = "Container App Environment must stay externally load balanced (parity: internal=false)."
  }

  assert {
    condition     = anytrue([for p in azurerm_container_app_environment.main.workload_profile : p.workload_profile_type == "Consumption"])
    error_message = "Workload profile must stay Consumption."
  }

  assert {
    condition     = azurerm_container_app_environment.main.infrastructure_subnet_id == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Network/virtualNetworks/vnet-mock/subnets/snet-aca"
    error_message = "Container App Environment must be VNet-injected into the delegated subnet."
  }
}




