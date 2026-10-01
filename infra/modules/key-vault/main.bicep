// Key Vault for the Helpdesk runtime secrets.
//
// The vault holds NO secret values in this template and never will. A secret
// value committed to a Bicep file lives forever in the git history of a
// repository that is pushed to a forge, so the vault is created empty and values
// are written out of band by an operator. The vault's only job is to hold the
// values the container apps resolve at start-up through their managed identity.
//
// WHICH SECRETS BELONG HERE: the ones whose names already exist in the
// application source. The portal reads OPENAI_API_KEY, MINIERP_INTEGRATION_KEY
// and LAB_AUTH_USERS (internal-portal/.env.example); the gateway reads
// LLM_CLOUD_API_KEY and the LLM_* family (llm-gateway/.env.example). Every
// secret name this module is given MUST already be read by that code -- see
// docs/enterprise-target/CONFIG-CONTRACT.md, which is the authoritative list.
// Inventing a new name in a template is how a secret ends up provisioned and
// never read.

targetScope = 'resourceGroup'

@description('Deployment region. Key Vault region is fixed per vault and cannot be moved; a migration means recreating the vault and every secret in it.')
param location string

@description('Directory (tenant) id that owns the vault. No default, because a real tenant id is environment data and must never be committed.')
param tenantId string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Name of the vault. Must be globally unique: 3-24 alphanumeric or hyphen characters, no trailing hyphen.')
param keyVaultName string

@description('Owner contact recorded on the vault.')
param ownerContact string

@description('Enables private-endpoint-only access. When false the vault keeps a public endpoint and networkAcls stays wide open, because a Deny default with no private endpoint would lock the workload out of its own secrets. Flipping this to true requires the private endpoint in infra/modules/private-endpoints to exist first.')
param enablePrivateNetwork bool = false

@description('Days a soft-deleted secret is recoverable for. 90 is the platform maximum and the default, stated explicitly so a compliance reviewer does not have to look it up.')
param softDeleteRetentionInDays int = 90

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
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
    // RBAC only. The access-policy model is a second authorisation system that
    // is off by default in a new vault and easy to leave enabled next to RBAC,
    // which is how a "no access" audit finding happens.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    // Purge protection is what turns an accidental secret delete from an outage
    // into a support ticket. Irreversible once enabled, which is why
    // infra/scripts/check_invariants.py asserts it rather than trusting the
    // default.
    enablePurgeProtection: true
    publicNetworkAccess: enablePrivateNetwork ? 'Disabled' : 'Enabled'
    networkAcls: {
      // AzureServices bypass is required for the trusted services (Backup, and
      // Key Vault-managed HSM operations) that cannot present a private link.
      bypass: 'AzureServices'
      defaultAction: enablePrivateNetwork ? 'Deny' : 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

@description('URI of the vault, including the trailing slash. Used to build the keyVaultUrl of each Container Apps secret reference.')
output keyVaultUri string = keyVault.properties.vaultUri

@description('Resource id of the vault. The scope for the Key Vault Secrets User role assignment in infra/modules/rbac.')
output keyVaultId string = keyVault.id

@description('Name of the vault, for `az keyvault secret set --vault-name` calls in the deployment runbook.')
output keyVaultNameOutput string = keyVault.name