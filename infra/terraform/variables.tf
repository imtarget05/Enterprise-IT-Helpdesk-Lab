# =============================================================================
#  Root input variables — Enterprise IT Helpdesk Lab
#
#  Parity note (Phase 1 gate): every root parameter of ../main.bicep has a
#  Terraform counterpart here with the same name intent and the same default.
#  Two deliberate, documented divergences:
#
#   1. `name_suffix` — Bicep derives it from `uniqueString(resourceGroup().id)`,
#      an ARM-internal hash that cannot be reproduced outside ARM. Terraform
#      takes it as an explicit input so the plan is reproducible and reviewable.
#   2. `resource_group_name` — Bicep deploys *into* an existing resource group
#      (targetScope = 'resourceGroup'); Terraform therefore treats the resource
#      group as a pre-existing container and does NOT manage its lifecycle.
#      Phase 3 imports the resources inside it; nothing here creates or deletes
#      the resource group.
# =============================================================================

variable "resource_group_name" {
  description = "Existing resource group that holds the Helpdesk platform. Not managed by this configuration."
  type        = string
  default     = "rg-portfolio-evidence"
}

variable "location" {
  description = "Deployment region."
  type        = string
  default     = "southeastasia"
}

variable "tenant_id" {
  description = "Microsoft Entra tenant ID that owns the Key Vault."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.tenant_id))
    error_message = "tenant_id must be a GUID (Microsoft Entra tenant)."
  }
}

variable "environment_name" {
  description = "Environment name (dev, staging, prod)."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment_name)
    error_message = "environment_name must be one of: dev, staging, prod."
  }
}

variable "name_suffix" {
  description = "Unique name suffix for every resource name. Must be set explicitly per environment: Key Vault and PostgreSQL names must be globally unique."
  type        = string
  default     = "helpdesk-lab"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$", var.name_suffix))
    error_message = "name_suffix must be lowercase alphanumeric with optional internal hyphens (max 32 chars)."
  }
}

variable "postgres_admin_password" {
  description = "PostgreSQL administrator password. Supply via TF_VAR_postgres_admin_password or a Key Vault reference — never commit a real value."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.postgres_admin_password) >= 8 && length(var.postgres_admin_password) <= 128
    error_message = "Azure PostgreSQL administrator password must be 8-128 characters."
  }
}

variable "container_image" {
  description = "Container image for the Helpdesk portal. Prefer an immutable digest reference (Phase 9) over a mutable tag."
  type        = string
  default     = "ghcr.io/imtarget05/enterprise-it-helpdesk-lab-it-portal:latest"
}

variable "postgres_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "16"
}

variable "postgres_sku_name" {
  description = "PostgreSQL Flexible Server SKU (Burstable tier)."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  description = "PostgreSQL storage in MB (32768 MB = 32 GB, matching the Bicep module)."
  type        = number
  default     = 32768
}

variable "postgres_backup_retention_days" {
  description = "PostgreSQL backup retention window in days."
  type        = number
  default     = 7
}

variable "servicebus_queue_name" {
  description = "Automation queue name for the deterministic executor."
  type        = string
  default     = "helpdesk-automation-jobs"
}

variable "container_app_min_replicas" {
  description = "Minimum Container App replicas."
  type        = number
  default     = 1
}

variable "container_app_max_replicas" {
  description = "Maximum Container App replicas."
  type        = number
  default     = 3
}

variable "container_app_cpu" {
  description = "Container CPU cores."
  type        = number
  default     = 0.5
}

variable "container_app_memory" {
  description = "Container memory."
  type        = string
  default     = "1.0Gi"
}
