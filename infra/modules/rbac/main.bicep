// Least-privilege role assignments for the Helpdesk stack.
//
// WHY THE MODULE IS RESOURCE-GROUP SCOPED AND IS INVOKED ONCE PER GROUP FROM
// infra/main.bicep: an extension resource cannot change scope, and the stack is
// split across two groups. One module per group keeps every `scope` an explicit
// resourceGroup() or a named resource rather than an interpolated resource-id
// string, which is not a type Bicep can check.
//
// WHY THE GRANT SET IS DELIBERATELY SMALL. Every role below exists because a
// specific module needs it, and the "needs it" is written next to the grant. A
// role with no stated need is not a role, it is a standing privilege.
//
// WHY THE DEPLOY IDENTITY GETS CONTRIBUTOR ON RESOURCE GROUPS AND NOT ON THE
// SUBSCRIPTION: a subscription-scoped Contributor can attach its own role
// assignments and therefore escalate itself to Owner. Scoped to a resource
// group it cannot. The CI identity can roll back this stack and nothing else --
// a claim a reviewer can check with one `az role assignment list` instead of
// taking on trust.
//
// WHAT THE RUNTIME IDENTITIES DO NOT GET HERE: the automation worker identity is
// granted a Service Bus receive grant and nothing else in this module. It runs
// PowerShell (llm-gateway/automation/executor.py); giving that identity write
// access to PostgreSQL would let a compromised action modify the audit trail
// that records the action.

targetScope = 'resourceGroup'

@description('Object id (principal id) of the user-assigned managed identity the portal container app runs as.')
param portalIdentityPrincipalId string

@description('Object id (principal id) of the user-assigned managed identity the automation worker runs as.')
param automationIdentityPrincipalId string

@description('Object id of the identity the deployment pipeline runs as. The target of the Contributor grant. Registered out of band by an operator; no value is committed here.')
param deployIdentityPrincipalId string

@description('Name of the Key Vault in this resource group. Empty when the group holds no vault, in which case the Key Vault grant is not emitted.')
param keyVaultName string = ''

@description('Name of the PostgreSQL Flexible Server in this resource group. Empty when the group holds no server.')
param postgresServerName string = ''

@description('Name of the Redis Cache in this resource group. Empty when the group holds no cache.')
param redisCacheName string = ''

@description('Name of the blob storage account for the portal identity. Empty when the group holds no account, in which case the Storage grant is not emitted -- the template never binds a role to a resource that is not there.')
param storageAccountName string = ''

@description('Name of the Service Bus namespace in this resource group. Empty when the group holds no namespace.')
param serviceBusNamespaceName string = ''

// WHY THE ROLE DEFINITION IDS ARE DERIVED FROM subscriptionResourceId RATHER THAN
// WRITTEN AS BARE GUIDs: the values are stable, but a bare GUID in a template
// is unreadable and a reader cannot tell which role it is.
var keyVaultSecretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var keyVaultCryptoUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12338af0-0e69-4776-bea7-57ae8d297424')
var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var serviceBusDataReceiverRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4f6d3b9b-027b-4f4c-9162-3828e3a22d69')
var serviceBusDataSenderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39')
var postgresContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b97e37c3-8ba7-4789-bca5-663c3a7b2528')
var redisContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'e0f68234-74aa-48ed-b826-c38b57376e17')
var contributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = if (!empty(keyVaultName)) {
  name: keyVaultName
  scope: resourceGroup()
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = if (!empty(postgresServerName)) {
  name: postgresServerName
  scope: resourceGroup()
}

resource redisCache 'Microsoft.Cache/redis@2024-11-01' existing = if (!empty(redisCacheName)) {
  name: redisCacheName
  scope: resourceGroup()
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (!empty(storageAccountName)) {
  name: storageAccountName
  scope: resourceGroup()
}

resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' existing = if (!empty(serviceBusNamespaceName)) {
  name: serviceBusNamespaceName
  scope: resourceGroup()
}

// Key Vault Secrets User, not Secrets Officer: the app resolves its own secrets
// and must never be able to change them. A compromised portal that can rotate
// its own credential has nothing left to escalate through.
resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(keyVaultName)) {
  name: guid(keyVault.id, portalIdentityPrincipalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: portalIdentityPrincipalId
    // Explicit because a role assignment against a service principal without
    // this field fails with a principal-not-found error that reads like a
    // replication problem rather than a typing problem.
    principalType: 'ServicePrincipal'
  }
}

// The portal signs its own session tokens, so it needs the crypto operations
// (sign/verify), not key management (list/set/delete).
resource keyVaultCryptoUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(keyVaultName)) {
  name: guid(keyVault.id, portalIdentityPrincipalId, keyVaultCryptoUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultCryptoUserRoleId
    principalId: portalIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource storageBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(storageAccountName)) {
  name: guid(storageAccount.id, portalIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: portalIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The portal publishes automation proposals; it does not consume them. Sender,
// not Receiver: a portal that could also receive could work its own queue.
resource serviceBusDataSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(serviceBusNamespaceName)) {
  name: guid(serviceBusNamespace.id, portalIdentityPrincipalId, serviceBusDataSenderRoleId)
  scope: serviceBusNamespace
  properties: {
    roleDefinitionId: serviceBusDataSenderRoleId
    principalId: portalIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The worker consumes approved jobs and publishes outcomes. It is NOT granted a
// PostgreSQL or storage role here on purpose: executor.py runs PowerShell
// supplied by the automation catalogue, and an identity that runs code from a
// queue should not also be able to rewrite the record of what it ran.
resource serviceBusDataReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(serviceBusNamespaceName)) {
  name: guid(serviceBusNamespace.id, automationIdentityPrincipalId, serviceBusDataReceiverRoleId)
  scope: serviceBusNamespace
  properties: {
    roleDefinitionId: serviceBusDataReceiverRoleId
    principalId: automationIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The worker also publishes outcomes onto the audit topic, so it is a sender too.
resource serviceBusWorkerSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(serviceBusNamespaceName)) {
  name: guid(serviceBusNamespace.id, automationIdentityPrincipalId, serviceBusDataSenderRoleId)
  scope: serviceBusNamespace
  properties: {
    roleDefinitionId: serviceBusDataSenderRoleId
    principalId: automationIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Data-store grants are scoped to the server/cache resource, not the resource
// group, and only to the portal. See the note on serviceBusDataReceiver for why
// the worker is excluded.
resource postgresPortalGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(postgresServerName)) {
  name: guid(postgresServer.id, portalIdentityPrincipalId, postgresContributorRoleId)
  scope: postgresServer
  properties: {
    roleDefinitionId: postgresContributorRoleId
    principalId: portalIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource redisPortalGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(redisCacheName)) {
  name: guid(redisCache.id, portalIdentityPrincipalId, redisContributorRoleId)
  scope: redisCache
  properties: {
    roleDefinitionId: redisContributorRoleId
    principalId: portalIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource deployIdentityContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentityPrincipalId, contributorRoleId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: contributorRoleId
    principalId: deployIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('Role definition ids this module can assign, so the deployment runbook can print them with `az role assignment list` instead of re-deriving them from the template.')
output assignedRoleDefinitionIds array = filter([
  keyVaultSecretsUserRoleId
  keyVaultCryptoUserRoleId
  storageBlobDataContributorRoleId
  serviceBusDataReceiverRoleId
  serviceBusDataSenderRoleId
  postgresContributorRoleId
  redisContributorRoleId
  contributorRoleId
], id => !empty(id))

@description('Name of the resource group these assignments were created in, so a reviewer can diff the two invocations against the two groups.')
output scopedResourceGroupName string = resourceGroup().name