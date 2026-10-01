// Key Vault module for Enterprise IT Helpdesk Lab secrets.
// Enforces RBAC authorization only and irreversible purge protection.

targetScope = 'resourceGroup'

@description('Deployment region')
param location string

@description('Azure AD Tenant ID owning the vault')
param tenantId string

@description('Environment name tag')
param environmentName string

@description('Key Vault name (globally unique)')
param keyVaultName string

@description('Days a soft-deleted secret is recoverable for')
param softDeleteRetentionInDays int = 90

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
