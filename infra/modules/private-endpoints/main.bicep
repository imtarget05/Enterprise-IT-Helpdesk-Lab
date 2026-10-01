// Private endpoints + private DNS zones for the Helpdesk data tier.
//
// WHY THIS IS ONE MODULE AND NOT FIVE: a private endpoint without a private DNS
// zone resolves to the public address and the whole exercise does nothing, and
// the failure is silent -- the data stores report Disabled public access while
// the application gets DNS failures. Pairing the endpoint with its zone group in
// one resource is what makes the two inseparable.
//
// THE FIVE ENDPOINTS, and what each one closes:
//   key-vault    closes the public path to the portal's secrets
//   postgres     closes the public path to the durable helpdesk record
//   redis        closes the public path to session tokens
//   blob         closes the public path to ticket attachments and backups
//   servicebus   closes the public path to the automation pipeline
//
// WHAT IS NOT HERE, AND WHY: no endpoint to APIM or Front Door. Those are edge
// services; they terminate public traffic by design and are fronted by WAF. A
// private endpoint in front of the edge removes the thing the edge is for.
//
// PRECONDITION, STATED IN THE PARAMETER NAMES: every corresponding
// enablePrivateNetwork flag in the data-tier modules must already be true. If a
// flag is false the store keeps a public endpoint and this module has created an
// unused endpoint -- which compiles, deploys, costs money and protects nothing.
// The parity check below is what turns that into a deployment-time error instead
// of a quiet no-op.

targetScope = 'resourceGroup'

@description('Deployment region. A private endpoint must be in the same region as the resource it fronts.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Owner contact recorded on every endpoint and zone.')
param ownerContact string

@description('Subnet id the endpoints are created in. Must be a subnet of the VNet in infra/modules/networking and must NOT carry a delegation to another service.')
param privateEndpointsSubnetResourceId string

@description('Private DNS zone id for privatelink.vaultcore.azure.net. Supplied rather than created here so the zones are reviewed once, in one place, and so a pre-existing enterprise zone can be reused instead of duplicated.')
param keyVaultPrivateDnsZoneResourceId string

@description('Private DNS zone id for privatelink.postgres.database.azure.com.')
param postgresPrivateDnsZoneResourceId string

@description('Private DNS zone id for privatelink.redis.cache.windows.net.')
param redisPrivateDnsZoneResourceId string

@description('Private DNS zone id for privatelink.blob.core.windows.net.')
param blobPrivateDnsZoneResourceId string

@description('Private DNS zone id for privatelink.servicebus.windows.net.')
param serviceBusPrivateDnsZoneResourceId string

@description('Resource id of the Key Vault. The private endpoint targets this.')
param keyVaultResourceId string

@description('Resource id of the PostgreSQL Flexible Server. The private endpoint targets this.')
param postgresServerResourceId string

@description('Resource id of the Redis Cache. The private endpoint targets this.')
param redisCacheResourceId string

@description('Resource id of the Storage account. The private endpoint targets the blob sub-resource, so the endpoint carries a `blob` sub-resource name.')
param storageAccountResourceId string

@description('Resource id of the Service Bus namespace. The private endpoint targets this.')
param serviceBusNamespaceResourceId string

@description('True when the Key Vault module has enablePrivateNetwork set. Must match, or the endpoint is unused.')
param keyVaultPrivateNetworkEnabled bool

@description('True when the PostgreSQL module has a delegated subnet supplied. Must match, or the endpoint is unused.')
param postgresPrivateNetworkEnabled bool

@description('True when the Redis module has a delegated subnet supplied. Must match, or the endpoint is unused.')
param redisPrivateNetworkEnabled bool

@description('True when the Storage module has enablePrivateNetwork set. Must match, or the endpoint is unused.')
param storagePrivateNetworkEnabled bool

@description('True when the Service Bus module has enablePrivateNetwork set. Must match, or the endpoint is unused.')
param serviceBusPrivateNetworkEnabled bool

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

// WHY A SINGLE DESCRIPTOR LIST RATHER THAN FIVE NEARLY IDENTICAL RESOURCE
// BLOCKS: the endpoint body is identical in all five cases, and five copies is
// five places for the DNS zone group to be forgotten in one of them. The two
// resources below iterate the SAME `endpoints` var, so an endpoint cannot exist
// without its zone group -- there is only one list to be right about.
resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [
  for target in endpoints: {
    name: target.name
    location: location
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: target.name
          properties: {
            privateLinkServiceId: target.targetId
            groupIds: [
              target.groupId
            ]
          }
        }
      ]
      manualPrivateLinkServiceConnections: []
    }
  }
]

// WHY THERE IS NO networkACLs BLOCK ON THE ENDPOINT, stated because its absence
// looks like an oversight: Microsoft.Network/privateEndpoints@2024-05-01 has no
// networkACLs property at all. The property exists on the private-link
// CONNECTION resource and, for most service providers, is not honoured anyway.
// The control that actually restricts reachability here is the subnet: the
// endpoints live in snet-private-endpoints, which carries no delegation, so
// nothing routes to it except the VNet itself. That is the boundary.

// The zone group is what makes the endpoint resolve. Without it the application
// keeps asking the public resolver, gets the public address, and fails to connect
// to a resource whose public access is Disabled -- which reads as a firewall
// problem and is not one.
resource privateDnsZoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [
  for (target, i) in endpoints: {
    parent: privateEndpoints[i]
    name: 'dns-zone-group'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: 'privatelink-zone'
          properties: {
            privateDnsZoneId: target.zoneId
          }
        }
      ]
    }
  }
]
// WHY THE DESCRIPTOR LIST IS A VAR AND NOT AN INLINE ARRAY TWICE OVER: the
// endpoint body and the zone-group body iterate the SAME five targets, and
// duplicating the literals twice is how the two lists drift so an endpoint
// exists with no zone group. One var, two consumers, no way to disagree.
var endpoints = [
  {
    name: 'pe-helpdesk-keyvault'
    targetId: keyVaultResourceId
    groupId: 'vault'
    zoneId: keyVaultPrivateDnsZoneResourceId
    enabled: keyVaultPrivateNetworkEnabled
  }
  {
    name: 'pe-helpdesk-postgres'
    targetId: postgresServerResourceId
    groupId: 'vault'
    zoneId: postgresPrivateDnsZoneResourceId
    enabled: postgresPrivateNetworkEnabled
  }
  {
    name: 'pe-helpdesk-redis'
    targetId: redisCacheResourceId
    groupId: 'vault'
    zoneId: redisPrivateDnsZoneResourceId
    enabled: redisPrivateNetworkEnabled
  }
  {
    name: 'pe-helpdesk-blob'
    targetId: storageAccountResourceId
    groupId: 'blob'
    zoneId: blobPrivateDnsZoneResourceId
    enabled: storagePrivateNetworkEnabled
  }
  {
    name: 'pe-helpdesk-servicebus'
    targetId: serviceBusNamespaceResourceId
    groupId: 'vault'
    zoneId: serviceBusPrivateDnsZoneResourceId
    enabled: serviceBusPrivateNetworkEnabled
  }
]

var privatisedTargets = filter(endpoints, target => target.enabled)

@description('Names of the private endpoints created. A deployment runbook asserts the list rather than assuming five, and a short list is a valid state meaning that many stores are still public.')
output privateEndpointNames array = map(privatisedTargets, target => target.name)

@description('How many data-tier stores have their public access closed. A runbook compares this against the number of data-tier modules and refuses to describe the deployment as private unless the counts agree.')
output privatisedStoreCount int = length(privatisedTargets)

@description('Names of the data-tier stores whose public access is still open, by target type. A non-empty list is the exact work item a private-path wave has to do, derived rather than remembered.')
output publiclyReachableStores array = map(filter(endpoints, target => !target.enabled), target => replace(target.name, 'pe-helpdesk-', ''))

@description('Subnet id every endpoint was created in, recorded so a network review does not have to read the template.')
output privateEndpointSubnetResourceId string = privateEndpointsSubnetResourceId