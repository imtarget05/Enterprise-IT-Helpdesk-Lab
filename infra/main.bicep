// Root orchestration template for Enterprise IT Helpdesk Platform.
// Provisions VNet, Key Vault, PostgreSQL, Service Bus, Observability, and Container Apps.

targetScope = 'resourceGroup'

@description('Deployment region')
param location string = resourceGroup().location

@description('Azure AD Tenant ID')
param tenantId string

@description('Environment name (dev, staging, prod)')
@allowed([
  'dev'
  'staging'
  'prod'
])
param environmentName string = 'prod'

@description('Unique name suffix for resource uniqueness')
param nameSuffix string = 'helpdesk-${uniqueString(resourceGroup().id)}'

@description('PostgreSQL Administrator Password')
@secure()
param postgresAdminPassword string

@description('Container Image for Helpdesk Portal')
param containerImage string = 'ghcr.io/imtarget05/enterprise-it-helpdesk-lab:latest'

// 1. Virtual Network
module network 'modules/network/vnet.bicep' = {
  name: 'networkDeployment'
  params: {
    location: location
    environmentName: environmentName
    vnetName: 'vnet-${nameSuffix}'
  }
}

// 2. Observability (Log Analytics + App Insights)
module observability 'modules/observability/main.bicep' = {
  name: 'observabilityDeployment'
  params: {
    location: location
    environmentName: environmentName
    workspaceName: 'log-${nameSuffix}'
    appInsightsName: 'appi-${nameSuffix}'
  }
}

// 3. Key Vault (RBAC + Purge Protection)
module keyVault 'modules/keyvault/main.bicep' = {
  name: 'keyVaultDeployment'
  params: {
    location: location
    tenantId: tenantId
    environmentName: environmentName
    keyVaultName: 'kv-${take(replace(nameSuffix, '-', ''), 21)}'
  }
}

// 4. PostgreSQL Flexible Server (Durable Truth)
module database 'modules/database/postgres.bicep' = {
  name: 'databaseDeployment'
  params: {
    location: location
    environmentName: environmentName
    serverName: 'psql-${nameSuffix}'
    administratorLoginPassword: postgresAdminPassword
  }
}

// 5. Service Bus Standard (Queue Automation)
module messaging 'modules/messaging/servicebus.bicep' = {
  name: 'messagingDeployment'
  params: {
    location: location
    environmentName: environmentName
    namespaceName: 'sb-${nameSuffix}'
    queueName: 'helpdesk-automation-jobs'
  }
}

// 6. Azure Container App (Portal)
module portalApp 'modules/apps/portal.bicep' = {
  name: 'portalAppDeployment'
  params: {
    location: location
    environmentName: environmentName
    managedEnvironmentName: 'cae-${nameSuffix}'
    containerAppName: 'ca-helpdesk-portal'
    containerImage: containerImage
    infrastructureSubnetId: network.outputs.acaSubnetId
    keyVaultUri: keyVault.outputs.keyVaultUri
    appInsightsConnectionString: observability.outputs.appInsightsConnectionString
  }
}

output portalFqdn string = portalApp.outputs.appFqdn
output postgresFqdn string = database.outputs.serverFqdn
output serviceBusNamespace string = messaging.outputs.namespaceName
output keyVaultUri string = keyVault.outputs.keyVaultUri
