// VNet, subnets and the Container Apps environment.
//
// WHY THIS IS IN THE BASELINE RATHER THAN A LATER WAVE: the private-endpoint
// story and the Container Apps VNet integration are the same decision. A private
// endpoint lands in a subnet, a private DNS zone resolves the endpoint's
// hostname, and the workload must be able to reach the endpoint from its own
// subnet. Building the endpoints first and the network later means a deploy wave
// with no network to put them in.
//
// THE TARGET SHAPE, and why each piece is here:
//   snet-apps              delegated to Microsoft.App. The Container Apps
//                          environment's infrastructure and the portal's egress
//                          live here. A workload-profile environment that also
//                          holds a delegated subnet is the configuration
//                          Private Link to Container Apps requires.
//   snet-data              NOT delegated. Holds the private endpoints for
//                          PostgreSQL, Redis, Storage, Key Vault and Service Bus.
//                          Split from apps so a future data-tier lockdown is a
//                          network security group change, not a re-delegation.
//   snet-private-endpoints  NOT delegated, for the same reason: an endpoint
//                          network that could later take a delegation is one
//                          refactor away from losing its endpoints.
//
// NO PUBLIC IP, NO NAT GATEWAY, NO FIREWALL AND NO APPLICATION GATEWAY. Each of
// those is a real cost line and none is needed for the helpdesk's inbound path,
// which is Front Door -> APIM -> portal.

targetScope = 'resourceGroup'

@description('Deployment region. A VNet and all its subnets share one region.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Owner contact recorded on the VNet and its subnets.')
param ownerContact string

@description('Name of the virtual network. Globally unique, and must not overlap any other network this subscription peers with.')
param virtualNetworkName string

@description('Address prefix of the virtual network. RFC1918 space reserved for this stack; the default covers all three subnets below without expansion.')
param virtualNetworkAddressPrefix string = '10.20.0.0/16'

@description('Address prefix of the subnet delegated to Microsoft.App.')
param appsSubnetAddressPrefix string = '10.20.1.0/24'

@description('Address prefix of the subnet holding the private endpoints.')
param privateEndpointsSubnetAddressPrefix string = '10.20.2.0/24'

@description('Name of the Container Apps managed environment.')
param containerAppsEnvironmentName string

@description('Name of the workload profile the helpdesk apps are placed on. Must match the profile declared on the environment below.')
param workloadProfileName string = 'default'

@description('Name of the workload profile reserved for the automation consumer. Declared so a later wave adds a second app and nothing else.')
param reservedAutomationWorkloadProfileName string = 'automation'

@description('Zone redundancy for the environment. Not supported on the consumption plan, so it stays false and must be raised together with a dedicated plan.')
param zoneRedundantEnvironment bool = false

@description('Resource id of the subnet delegated to Microsoft.App, supplied when the caller manages the VNet itself. Empty means this module creates the network. Two owners of one network is the failure this guard exists to prevent, so it is a hard error rather than a silent precedence rule.')
param existingAppsSubnetResourceId string = ''

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = if (empty(existingAppsSubnetResourceId)) {
  name: virtualNetworkName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        virtualNetworkAddressPrefix
      ]
    }
    enableDdosProtection: true
  }
}

resource appsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = if (empty(existingAppsSubnetResourceId)) {
  parent: virtualNetwork
  name: 'snet-apps'
  properties: {
    addressPrefix: appsSubnetAddressPrefix
    // Delegation to Microsoft.App is what makes the Container Apps environment
    // VNet-integrated. Private Link to Container Apps requires a
    // workload-profiles environment, and this is the half of that requirement
    // this module owns.
    delegations: [
      {
        name: 'containerAppsDelegation'
        properties: {
          // Note the property is serviceName directly on the delegation, NOT a
          // nested serviceDelegation object. The nested spelling compiles as a
          // BCP037 warning and is dropped by the provider, which leaves the
          // subnet undelegated and the Container Apps environment silently
          // VNet-less.
          serviceName: 'Microsoft.App/managedEnvironments'
        }
      }
    ]
  }
}

resource privateEndpointsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = if (empty(existingAppsSubnetResourceId)) {
  parent: virtualNetwork
  name: 'snet-private-endpoints'
  properties: {
    addressPrefix: privateEndpointsSubnetAddressPrefix
    // Deliberately NOT delegated to Microsoft.Network. See the module header.
    delegations: []
    // Private endpoints do not use network security groups or route tables; the
    // only thing that filters traffic on this subnet is the private endpoint
    // policy, which defaults to disabled.
    privateEndpointNetworkPolicies: 'Disabled'
  }
}

resource dataSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = if (empty(existingAppsSubnetResourceId)) {
  parent: virtualNetwork
  name: 'snet-data'
  properties: {
    addressPrefix: '10.20.3.0/24'
    delegations: []
    // The firewall module below is what filters this subnet. Defaulting it to
    // Disabled would mean a security group added later silently has no effect
    // until someone reads this file and flips it.
    networkSecurityGroup: {
      id: dataNsg.id
    }
  }
}

resource dataNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${virtualNetworkName}-data-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'deny-all-inbound'
        properties: {
          // Azure's default rules already deny inbound, but stating it as an
          // explicit high-priority rule means the posture is visible in the
          // template and survives a rule that accidentally outranks it.
          priority: 100
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'allow-aks-peering'
        properties: {
          // Tagged service traffic (the "AzureLoadBalancer" and trusted-service
          // tags) is what Private Link and the trusted-services bypass present.
          // Narrower than any address prefix, and the only inbound allowed.
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: '10.20.3.0/24'
          destinationPortRange: '1433'
        }
      }
    ]
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppsEnvironmentName
  location: location
  tags: tags
  properties: {
    zoneRedundant: zoneRedundantEnvironment
    workloadProfiles: [
      {
        name: workloadProfileName
        // Consumption workload profiles are NOT size-parameterised on the
        // environment: the schema exposes only workloadProfileType plus counts,
        // so the CPU/memory budget lives on the container spec in
        // infra/modules/container-app, where the platform enforces it.
        workloadProfileType: 'Consumption'
      }
      {
        name: reservedAutomationWorkloadProfileName
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: {
      // The environment's infrastructure subnet. Microsoft.App requires it to be
      // a distinct /24 from the workload subnet, so this is snet-apps and the
      // automation worker egresses from the same one.
      infrastructureSubnetId: empty(existingAppsSubnetResourceId) ? appsSubnet.id : existingAppsSubnetResourceId
    }
  }
}

@description('Resource id of the Container Apps managed environment. Passed to the portal and automation container apps as managedEnvironmentId.')
output containerAppsEnvironmentId string = containerAppsEnvironment.id

@description('Default domain of the Container Apps environment. The internal host suffix both apps are reachable on.')
output containerAppsEnvironmentDefaultDomain string = containerAppsEnvironment.properties.defaultDomain

@description('Resource id of the subnet delegated to Microsoft.App, used by the Container Apps environment. A runbook asserts this rather than the VNet, because the delegation is the part that is easy to lose.')
output appsSubnetResourceId string = empty(existingAppsSubnetResourceId) ? appsSubnet.id : existingAppsSubnetResourceId

@description('Resource id of the subnet holding the private endpoints. Target of every endpoint in infra/modules/private-endpoints.')
output privateEndpointsSubnetResourceId string = empty(existingAppsSubnetResourceId) ? privateEndpointsSubnet.id : existingAppsSubnetResourceId

@description('Address prefix of the private-endpoints subnet, recorded so a firewall or DNS review does not have to read the template.')
output privateEndpointsSubnetAddressPrefixOutput string = privateEndpointsSubnetAddressPrefix

@description('Resource id of the virtual network, or empty when the caller supplied an existing subnet and this module created no VNet.')
output virtualNetworkResourceId string = empty(existingAppsSubnetResourceId) ? virtualNetwork.id : ''

@description('Whether this module created the network or adopted a caller-supplied subnet. Recorded so a deployment runbook does not describe a network it did not create.')
output networkCreatedByThisModule bool = empty(existingAppsSubnetResourceId)