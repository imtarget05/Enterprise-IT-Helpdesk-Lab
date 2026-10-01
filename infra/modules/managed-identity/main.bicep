// Workload identity for the Helpdesk workloads.
//
// This module creates the user-assigned managed identities ONLY. It creates no
// Entra ID application registration.
//
// WHY THAT IS A DELIBERATE DEVIATION FROM THE TEMPLATE THIS WAS BOOTSTRAPPED
// FROM: the portal authenticates its own users locally (internal-portal/src/
// auth.js, AUTH_MODE=legacy|lab) and the automation surface is guarded by
// role checks inside llm-gateway/automation/policy.py. Neither consumes an
// Entra-issued token, so a registration would be a credential that guards
// nothing. See docs/enterprise-target/CONFIG-CONTRACT.md.
//
// WHY user-assigned and not system-assigned: the identities are referenced from
// several scopes at once (the container apps, the Service Bus trigger, Key
// Vault data-plane reads and any future federated trust) and they must survive
// the destruction of the resource that created it. A system-assigned identity
// dies with its resource, which silently invalidates every role assignment bound
// to it.
//
// WHY no client secret anywhere: a secret in Key Vault still has to be read by
// something, and the thing that reads it is the workload. Managed identity
// removes the secret entirely -- there is nothing to leak, rotate or expire.

targetScope = 'resourceGroup'

@description('Deployment region. A managed identity must sit in the same region as the workload that authenticates with it.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Name of the user-assigned managed identity the helpdesk portal container app runs as.')
param portalIdentityName string

@description('Name of the user-assigned managed identity the llm-gateway / automation worker runs as.')
param automationIdentityName string

@description('Owner contact recorded on the identity resources.')
param ownerContact string

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource portalIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: portalIdentityName
  location: location
  tags: tags
}

resource automationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: automationIdentityName
  location: location
  tags: tags
}

@description('Resource id of the portal managed identity. Passed to the portal container app, which binds it as its runtime identity.')
output portalIdentityId string = portalIdentity.id

@description('Object id of the portal managed identity service principal. This is the principal every runtime role assignment targets -- never the client id.')
output portalIdentityPrincipalId string = portalIdentity.properties.principalId

@description('Client id of the portal managed identity. Passed as AZURE_CLIENT_ID for out-of-band data-plane calls.')
output portalIdentityClientId string = portalIdentity.properties.clientId

@description('Resource id of the automation worker managed identity.')
output automationIdentityId string = automationIdentity.id

@description('Object id of the automation worker managed identity service principal. The target of the Service Bus and data-store grants.')
output automationIdentityPrincipalId string = automationIdentity.properties.principalId

@description('Client id of the automation worker managed identity.')
output automationIdentityClientId string = automationIdentity.properties.clientId