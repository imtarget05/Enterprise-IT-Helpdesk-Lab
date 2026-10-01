// Resource group boundary for the Helpdesk enterprise stack.
//
// WHY two groups and not one: the blast radius of a compromised deploy identity
// must be provable from Azure role assignments alone. A Contributor scoped to
// exactly these two names can destroy the whole stack and nothing else; the same
// grant at subscription scope would reach every unrelated workload in the
// subscription.
//
// WHY data is separated from apps: the PostgreSQL server, the Redis cache and
// the storage account hold durable helpdesk state (tickets, assets, audit
// events, approval requests, automation run records). Keeping them in their own
// group means an operator with write access to the application tier never has
// write access to the record of what the application did.

targetScope = 'subscription'

@description('Deployment region. Every Helpdesk resource in this stack is regional, so one region is used end to end to keep Private Link and VNet paths simple.')
param location string

@description('Short environment name, e.g. "prod" or "dev". Propagated into the shared tag set so every resource is attributable.')
param environmentName string

@description('Name of the resource group holding the managed identities, the Key Vault and the durable data stores.')
param dataResourceGroupName string

@description('Name of the resource group holding the container apps, APIM, Front Door, monitoring and the VNet.')
param appsResourceGroupName string

@description('Owner contact recorded on every resource group. Must be a monitored mailbox: it is the only human route back to these resources.')
param ownerContact string

// WHY one shared tag object instead of per-resource literals: a compliance query
// ("what is in Helpdesk's prod footprint") is a single tag filter, and it cannot
// drift because there is only one place to edit.
var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource dataResourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: dataResourceGroupName
  location: location
  tags: tags
}

resource appsResourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: appsResourceGroupName
  location: location
  tags: tags
}

@description('Fully qualified resource id of the data resource group. Role assignments in infra/modules/rbac are scoped from this value, never from a string template.')
output dataResourceGroupId string = dataResourceGroup.id

@description('Fully qualified resource id of the apps resource group.')
output appsResourceGroupId string = appsResourceGroup.id