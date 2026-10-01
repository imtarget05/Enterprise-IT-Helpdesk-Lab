# =============================================================================
#  Module: messaging — parity with infra/modules/messaging/servicebus.bicep
#
#  Queue-driven deterministic execution. Invariants asserted by the plan
#  control: duplicate detection ON, dead-lettering on message expiration ON,
#  bounded max_delivery_count, TLS >= 1.2.
#
#  Boundary (must be stated in any claim): namespace-level secrets
#  (default_primary_key / connection strings) are provider-computed and are
#  NEVER exported from this module.
# =============================================================================

locals {
  tags = {
    env       = var.environment_name
    project   = "helpdesk"
    managedBy = "terraform"
  }
}

resource "azurerm_servicebus_namespace" "main" {
  name                          = var.namespace_name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  sku                           = "Standard"
  minimum_tls_version           = "1.2"
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_servicebus_queue" "automation_jobs" {
  name                                    = var.queue_name
  namespace_id                            = azurerm_servicebus_namespace.main.id
  lock_duration                           = var.lock_duration
  max_delivery_count                      = var.max_delivery_count
  dead_lettering_on_message_expiration    = true
  requires_duplicate_detection            = true
  duplicate_detection_history_time_window = var.duplicate_detection_history_time_window
  batched_operations_enabled              = true
}
