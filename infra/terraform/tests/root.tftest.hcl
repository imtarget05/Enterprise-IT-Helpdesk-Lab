# =============================================================================
#  Root composition tests — Enterprise IT Helpdesk Lab (Phase 1 gate)
#
#  Runs fully offline: `mock_provider` replaces every Azure API call, so these
#  tests assert the *configuration semantics* (what would be sent to Azure),
#  not a live deployment. Runtime verification belongs to Phase 3+.
#
#  Run: cd infra/terraform && terraform test
# =============================================================================

mock_provider "azurerm" {
  # Mocked IDs must be syntactically valid Azure resource IDs: they are passed
  # between modules, and the azurerm provider validates ID formats on the
  # receiving side even when the provider is mocked.
  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.Network/virtualNetworks/vnet-mock/subnets/snet-mock"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.OperationalInsights/workspaces/log-mock"
    }
  }

  mock_resource "azurerm_servicebus_namespace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ServiceBus/namespaces/sb-mock"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.App/managedEnvironments/cae-mock"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      vault_uri = "https://kv-mock.vault.azure.net/"
      id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.KeyVault/vaults/kv-mock"
    }
  }

  mock_resource "azurerm_application_insights" {
    defaults = {
      connection_string   = "InstrumentationKey=00000000-0000-0000-0000-000000000000"
      instrumentation_key = "00000000-0000-0000-0000-000000000000"
      id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/microsoft.insights/components/appi-mock"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      fqdn = "psql-mock.postgres.database.azure.com"
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-mock"
    }
  }

  mock_resource "azurerm_container_app" {
    defaults = {
      latest_revision_fqdn = "ca-helpdesk-portal.mock.azurecontainerapps.io"
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.App/containerApps/ca-helpdesk-portal"
    }
  }
}

variables {
  resource_group_name     = "rg-mock-helpdesk"
  location                = "southeastasia"
  tenant_id               = "11111111-1111-1111-1111-111111111111"
  environment_name        = "prod"
  name_suffix             = "helpdesk-lab"
  postgres_admin_password = "NotARealPassword123!"
}

# ---------------------------------------------------------------------------
# 1. Resource naming parity with the Bicep root template
# ---------------------------------------------------------------------------
run "resource_names_match_bicep_parity" {
  command = plan

  assert {
    condition     = output.service_bus_queue_name == "helpdesk-automation-jobs"
    error_message = "Automation queue name must stay 'helpdesk-automation-jobs' (parity with main.bicep)."
  }

  assert {
    condition     = output.postgres_database_name == "helpdesk"
    error_message = "Primary database must be 'helpdesk' (parity with postgres.bicep)."
  }

  # Subnet wiring is asserted in tests/modules.tftest.hcl: a mocked subnet `id`
  # is identical for every subnet, so an equality check at the root would pass
  # even if the root wired the wrong subnet — a control that does not bite is
  # worse than no control.

  assert {
    condition     = output.key_vault_name == "kv-helpdesklab"
    error_message = "Key Vault name must follow Bicep's take(replace(nameSuffix,'-',''),21) rule → kv-helpdesklab."
  }
}

# ---------------------------------------------------------------------------
# 2. Composition wiring: module outputs must reach the portal container
# ---------------------------------------------------------------------------
run "modules_are_wired_together" {
  # apply against a MOCKED provider: no Azure call is made. Computed values
  # (vault URI, FQDN) only exist after apply, so a plan-only run cannot assert
  # that a module output actually reached the root output.
  command = apply

  assert {
    condition     = output.key_vault_uri == "https://kv-mock.vault.azure.net/"
    error_message = "Key Vault URI must flow from the keyvault module to the root output."
  }

  assert {
    condition     = output.postgres_fqdn == "psql-mock.postgres.database.azure.com"
    error_message = "PostgreSQL FQDN must flow from the database module to the root output."
  }

  assert {
    condition     = output.portal_fqdn != ""
    error_message = "Portal FQDN must be materialised from the apps module ingress."
  }

  assert {
    condition     = can(regex("^/subscriptions/.*/containerApps/ca-helpdesk-portal$", output.container_app_id))
    error_message = "Container App ID must flow from the apps module to the root output."
  }
}

# ---------------------------------------------------------------------------
# 3. Input validation must bite (negative controls)
# ---------------------------------------------------------------------------
run "rejects_invalid_environment_name" {
  command = plan

  variables {
    environment_name = "production"
  }

  expect_failures = [var.environment_name]
}

run "rejects_non_guid_tenant_id" {
  command = plan

  variables {
    tenant_id = "not-a-guid"
  }

  expect_failures = [var.tenant_id]
}

run "rejects_short_postgres_password" {
  command = plan

  variables {
    postgres_admin_password = "short"
  }

  expect_failures = [var.postgres_admin_password]
}

run "rejects_uppercase_name_suffix" {
  command = plan

  variables {
    name_suffix = "Helpdesk-LAB"
  }

  expect_failures = [var.name_suffix]
}
