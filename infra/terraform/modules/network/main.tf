# =============================================================================
#  Module: network — parity with infra/modules/network/vnet.bicep
#
#  Representation difference (documented in scripts/check_parity.py): Bicep
#  uses inline `subnets`, Terraform uses one azurerm_subnet per subnet so the
#  ACA subnet can be exported by name instead of by array index. The resulting
#  Azure resources are identical: 1 VNet + 3 subnets.
# =============================================================================

locals {
  tags = {
    env       = var.environment_name
    project   = "helpdesk"
    managedBy = "terraform"
  }
}

resource "azurerm_virtual_network" "main" {
  name                = var.vnet_name
  location            = var.location
  resource_group_name = var.resource_group_name
  address_space       = [var.address_prefix]
  tags                = local.tags
}

resource "azurerm_subnet" "infra" {
  name                 = "snet-infra"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.infra_subnet_prefix]
}

# Delegated subnet for Container Apps VNet injection.
resource "azurerm_subnet" "aca" {
  name                 = "snet-aca"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.aca_subnet_prefix]

  delegation {
    name = "Microsoft.App.environments"

    service_delegation {
      name = "Microsoft.App/environments"
    }
  }
}

resource "azurerm_subnet" "private_endpoints" {
  name                 = "snet-private-endpoints"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.private_endpoints_subnet_prefix]
}
