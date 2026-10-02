variable "location" {
  description = "Deployment region."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group to deploy into."
  type        = string
}

variable "environment_name" {
  description = "Environment name tag."
  type        = string
}

variable "namespace_name" {
  description = "Service Bus namespace name."
  type        = string
}

variable "queue_name" {
  description = "Automation queue name."
  type        = string
  default     = "helpdesk-automation-jobs"
}

variable "lock_duration" {
  description = "Queue lock duration (ISO-8601). Bounded so a crashed worker releases the message for retry."
  type        = string
  default     = "PT5M"
}

variable "max_delivery_count" {
  description = "Deliveries before the message is dead-lettered."
  type        = number
  default     = 10
}

variable "duplicate_detection_history_time_window" {
  description = "Duplicate detection window. Phase 5 relies on this + operation_id for exactly-once semantics."
  type        = string
  default     = "PT10M"
}
