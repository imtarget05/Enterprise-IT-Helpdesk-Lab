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

variable "managed_environment_name" {
  description = "Container App Environment name."
  type        = string
}

variable "container_app_name" {
  description = "Container App name."
  type        = string
}

variable "container_image" {
  description = "Container image reference."
  type        = string
}

variable "target_port" {
  description = "Container port the portal listens on."
  type        = number
  default     = 3000
}

variable "infrastructure_subnet_id" {
  description = "Delegated subnet for ACA VNet injection. Empty string disables VNet injection (parity with the Bicep `empty()` guard)."
  type        = string
  default     = ""
}

variable "key_vault_uri" {
  description = "Key Vault URI injected as KEY_VAULT_URI (not a secret)."
  type        = string
  default     = ""
}

variable "app_insights_connection_string" {
  description = "Application Insights connection string injected as an environment variable. Sensitive; never logged, never exported."
  type        = string
  sensitive   = true
  default     = ""
}

variable "log_analytics_workspace_id" {
  description = "Log Analytics workspace ID for the Container App Environment."
  type        = string
  default     = ""
}

variable "min_replicas" {
  description = "Minimum replicas."
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum replicas."
  type        = number
  default     = 3
}

variable "container_cpu" {
  description = "Container CPU cores. 0.5 pairs with 1.0Gi memory."
  type        = number
  default     = 0.5
}

variable "container_memory" {
  description = "Container memory."
  type        = string
  default     = "1.0Gi"
}
