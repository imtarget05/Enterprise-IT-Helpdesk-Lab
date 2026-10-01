variable "location" {
  description = "Deployment region."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group to deploy into."
  type        = string
}

variable "tenant_id" {
  description = "Microsoft Entra tenant ID owning the vault."
  type        = string
}

variable "environment_name" {
  description = "Environment name tag."
  type        = string
}

variable "key_vault_name" {
  description = "Key Vault name (globally unique, 3-24 chars, alphanumeric and hyphens)."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$", var.key_vault_name))
    error_message = "key_vault_name must be 3-24 characters, start with a letter, end with alphanumeric."
  }
}

variable "soft_delete_retention_in_days" {
  description = "Days a soft-deleted secret stays recoverable."
  type        = number
  default     = 90

  validation {
    condition     = var.soft_delete_retention_in_days >= 7 && var.soft_delete_retention_in_days <= 90
    error_message = "soft_delete_retention_in_days must be between 7 and 90."
  }
}
