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

variable "vnet_name" {
  description = "Virtual network name."
  type        = string
}

variable "address_prefix" {
  description = "VNet address space. Parity with modules/network/vnet.bicep."
  type        = string
  default     = "10.10.0.0/16"
}

variable "infra_subnet_prefix" {
  description = "Infrastructure subnet prefix."
  type        = string
  default     = "10.10.0.0/24"
}

variable "aca_subnet_prefix" {
  description = "Container Apps subnet prefix (must be /23 or larger for ACA VNet injection)."
  type        = string
  default     = "10.10.2.0/23"
}

variable "private_endpoints_subnet_prefix" {
  description = "Private endpoints subnet prefix (reserved for Phase 4)."
  type        = string
  default     = "10.10.4.0/24"
}
