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

variable "server_name" {
  description = "PostgreSQL Flexible Server name."
  type        = string
}

variable "administrator_login" {
  description = "Administrator login name."
  type        = string
  default     = "helpdeskadmin"
}

variable "administrator_password" {
  description = "Administrator login password."
  type        = string
  sensitive   = true
}

variable "postgres_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "16"
}

variable "sku_name" {
  description = "Burstable SKU name."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "storage_mb" {
  description = "Storage size in MB."
  type        = number
  default     = 32768
}

variable "backup_retention_days" {
  description = "Backup retention window in days."
  type        = number
  default     = 7
}

variable "public_network_access" {
  description = "Whether the server accepts public network access. Parity with the Bicep module (default enabled); Phase 4 replaces this with private endpoints."
  type        = bool
  default     = true
}

variable "database_name" {
  description = "Primary Helpdesk database name."
  type        = string
  default     = "helpdesk"
}
