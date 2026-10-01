// Redis Cache: ephemeral helpdesk state.
//
// WHAT LIVES HERE, and nothing else:
//   * session and authentication-token cache for the portal. The portal mints
//     its own tokens (AUTH_MODE=lab, LAB_AUTH_USERS in
//     internal-portal/.env.example); Redis holds the token->session mapping so a
//     token can be invalidated centrally.
//   * short-lived SLA countdown / breach-notification dedup state, so the same
//     ticket does not fire the same breach notification on every poll.
//   * duplicate-suppression keys for the automation job intake.
//
// WHY REDIS AND NOT THE DATABASE FOR THESE: none of it is a record of fact. A
// Redis flush loses a cache and nothing else; putting session state in
// PostgreSQL would mean every page load takes a write and the session table
// competes with the audit write path.
//
// THE HARD CONSTRAINT, STATED HERE BECAUSE IT IS EASY TO BREAK LATER: Redis is
// the ONLY cache in this stack, and there is NO vector store, NO Qdrant and NO
// embedding cache anywhere in this infrastructure. The helpdesk automation
// pipeline is queue-driven and row-driven; it does not retrieve over embeddings.
// If a future change adds one, it is a new module with its own decision record,
// not a configuration value on this one.

targetScope = 'resourceGroup'

@description('Deployment region.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Name of the Redis Cache. Globally unique, lowercase only.')
param redisCacheName string

@description('Redis SKU family. "C" is the cheapest tier that supports a private endpoint, which is the state this module targets.')
param redisFamily string = 'C'

@description('Redis capacity in GB.')
param redisCapacity int = 1

@description('Whether TLS is required on the Redis endpoint. On by default and asserted by infra/scripts/check_invariants.py: an unencrypted Redis link carries session tokens in clear.')
param redisMinimumTlsVersion string = '1.2'

@description('Owner contact recorded on the cache.')
param ownerContact string

@description('Subnet id delegated to Microsoft.Cache. Empty leaves the cache on its public endpoint, the pre-private-endpoint state.')
param delegatedSubnetResourceId string = ''

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource redisCache 'Microsoft.Cache/redis@2024-11-01' = {
  name: redisCacheName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'Standard'
      family: redisFamily
      capacity: redisCapacity
    }
    enableNonSslPort: false
    minimumTlsVersion: redisMinimumTlsVersion
    // No public endpoint once the cache is on a delegated subnet. A cache with
    // a public endpoint is an unauthenticated-by-default listener on the
    // internet in front of session tokens.
    publicNetworkAccess: empty(delegatedSubnetResourceId) ? 'Enabled' : 'Disabled'
    redisVersion: '7'
  }
}

resource redisFirewallRule 'Microsoft.Cache/redis/firewallRules@2024-11-01' = if (!empty(delegatedSubnetResourceId)) {
  parent: redisCache
  name: 'AllowPrivateSubnet'
  properties: {
    // A conservative superset of the VNet prefix this cache can be reached from
    // (10.20.0.0/16 in infra/modules/networking). A cache on a delegated subnet
    // still evaluates firewall rules, and an empty list blocks its own clients.
    // Note the property names are startIP/endIP, NOT startIpAddress/endIpAddress:
    // the ARM type really does use the capitalised form, and the wrong spelling
    // compiles as a warning and is then silently dropped by the provider.
    startIP: '10.20.0.1'
    endIP: '10.20.255.254'
  }
}

// NOTE: the private endpoint connection itself is created by
// infra/modules/private-endpoints, not here. A
// Microsoft.Cache/redis/privateEndpointConnections resource needs the resource
// id of a Microsoft.Network/privateEndpoints resource, and there is no such
// resource in this module -- declaring one here with the subnet id would
// compile and then fail at the provider, which is the worst of both worlds.
// The output below carries what that module needs.

@description('Host name of the Redis endpoint. Not a connection string: the application assembles credentials and the TLS flag itself.')
output redisHostName string = redisCache.properties.hostName

@description('Resource id of the cache. Scope for any role assignment against it.')
output redisCacheId string = redisCache.id

@description('Name of the cache, for `az redis` commands.')
output redisCacheNameOutput string = redisCache.name

@description('Whether the cache is currently on a private path.')
output redisUsesPrivateNetwork bool = !empty(delegatedSubnetResourceId)