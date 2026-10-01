output "namespace_id" {
  description = "Service Bus namespace resource ID."
  value       = azurerm_servicebus_namespace.main.id
}

output "namespace_name" {
  description = "Service Bus namespace name."
  value       = azurerm_servicebus_namespace.main.name
}

output "queue_id" {
  description = "Automation queue resource ID."
  value       = azurerm_servicebus_queue.automation_jobs.id
}

output "queue_name" {
  description = "Automation queue name."
  value       = azurerm_servicebus_queue.automation_jobs.name
}
