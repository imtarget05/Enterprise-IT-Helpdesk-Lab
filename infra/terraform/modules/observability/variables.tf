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

variable "workspace_name" {
  description = "Log Analytics workspace name."
  type        = string
}

variable "app_insights_name" {
  description = "Application Insights component name."
  type        = string
}

variable "log_retention_in_days" {
  description = "Log retention window (parity with the Bicep module: 30 days)."
  type        = number
  default     = 30
}
