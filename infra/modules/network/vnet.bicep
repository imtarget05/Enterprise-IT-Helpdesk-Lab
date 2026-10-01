// Virtual Network module for Enterprise IT Helpdesk Lab.
// Isolates workloads with dedicated subnets for infra, Container Apps, and Private Endpoints.

targetScope = 'resourceGroup'

@description('Deployment region')
param location string

@description('Environment name tag')
param environmentName string

@description('Virtual Network Name')
param vnetName string

@description('Address space prefix')
param addressPrefix string = '10.10.0.0/16'

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-infra'
        properties: {
          addressPrefix: '10.10.0.0/24'
        }
      }
      {
        name: 'snet-aca'
        properties: {
          addressPrefix: '10.10.2.0/23'
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: '10.10.4.0/24'
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output acaSubnetId string = vnet.properties.subnets[1].id
output privateEndpointsSubnetId string = vnet.properties.subnets[2].id
