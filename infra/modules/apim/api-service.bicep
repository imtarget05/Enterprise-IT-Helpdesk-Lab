// API Management instance for the Helpdesk edge.
//
// TIER DECISION -- Consumption, and the reasoning is written down because the
// answer changes when the deployment shape changes:
//   Required by this stack: rate limiting, a managed identity of its own, and
//   gateway logs. All GA on Consumption. The developer portal is the only
//   Consumption gap and it is switched off for a production deployment anyway.
//   Consumption vs Developer: Developer has a fixed hourly capacity, so a runaway
//   client is billed by the hour rather than capped. Developer is the correct
//   answer for a staging environment, which is why the SKU is a parameter.
//   Consumption vs Premium: Premium is the only tier that can be injected into a
//   virtual network or reached over a private endpoint. This stack does NOT put
//   APIM on a private path -- Front Door terminates public traffic in front of
//   it, and there is no private-endpoint module entry for APIM. Premium costs
//   roughly two orders of magnitude more per month. If a later wave does privatise
//   APIM, this becomes a one-line change in the parameter file.
//
// Developer portal: off. A developer portal on a production gateway is a
// publicly enumerable catalogue of the internal helpdesk API surface, behind an
// admin account that is the most phished credential in the deployment.

targetScope = 'resourceGroup'

@description('Deployment region. The APIM region cannot be changed after creation, and a backend in another region pays cross-region latency on every request.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Owner contact recorded on the service. Also sent as the APIM notification sender.')
param ownerContact string

@description('Name of the APIM service. Globally unique.')
param apimServiceName string

@description('APIM SKU. "Consumption" for prod, "Developer" for staging, "Premium" only when APIM itself is privatised.')
param apimSkuName string = 'Consumption'

@description('Capacity. 0 means serverless, which is the only valid value for Consumption and is ignored by Developer and Premium.')
param apimCapacity int = 0

@description('Email address recorded as the APIM publisher. API Management requires it and uses it for service notifications, so it must be a monitored mailbox.')
param apimPublisherEmail string

@description('Display name recorded as the APIM publisher.')
param apimPublisherName string

@description('Network configuration. "None" on Consumption; "External" on a Premium instance with VNet injection.')
param apimVirtualNetworkType string = 'None'

@description('Whether the gateway accepts traffic from the public internet. True while Front Door is the only intended caller, which is the state this template describes.')
param apimPublicNetworkAccess bool = true

@description('Expose the developer portal. Off: a public portal is an inventory of the internal helpdesk API surface.')
param apimDeveloperPortalEnabled bool = false

@description('Resource id of the Log Analytics workspace receiving gateway logs and metrics. No gateway log means no way to tell "the portal rejected it" from "the gateway rejected it", which is the first question in every incident.')
param logAnalyticsWorkspaceId string

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource apimService 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: apimServiceName
  location: location
  tags: tags
  identity: {
    // APIM needs its own identity to read Key Vault and to sign the client
    // certificate used for client-certificate authentication. Neither is used in
    // this baseline, but an identity cannot be added later to a Consumption
    // instance without a redeploy, so it is declared now.
    type: 'SystemAssigned'
  }
  sku: {
    name: apimSkuName
    capacity: apimCapacity
  }
  properties: {
    publisherName: apimPublisherName
    publisherEmail: apimPublisherEmail
    // Client certificates would be a second authentication path with its own CA
    // to operate. The token path is the only one here.
    enableClientCertificate: false
    publicNetworkAccess: apimPublicNetworkAccess ? 'Enabled' : 'Disabled'
    virtualNetworkType: apimVirtualNetworkType
    customProperties: {
      // HTTP/2 is not cosmetic: the portal's streaming and export routes are far
      // better on it, and over HTTP/1.1 the gateway buffers the response and the
      // client sees one result at the end instead of as it is produced.
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Protocols.Http2': 'true'
    }
  }
}

resource apimDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-apim'
  scope: apimService
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'ApiManagementGatewayLogs'
        enabled: true
      }
      {
        category: 'ApiManagementAuditLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

@description('Gateway URL of the APIM instance, e.g. "https://apim-helpdesk.azure-api.net". This is one of the registered redirect URIs and the Front Door origin.')
output apimGatewayUrl string = 'https://${apimService.properties.gatewayUrl}'

@description('Host name of the APIM gateway without a scheme.')
output apimGatewayHostName string = apimService.properties.gatewayUrl

@description('Name of the APIM service, used by az apim commands in the deployment runbook.')
output apimServiceNameOutput string = apimService.name

@description('Resource id of the APIM service. Passed to the API surface module as the parent scope, and the scope for any role assignment against the APIM system-assigned identity.')
output apimServiceId string = apimService.id

@description('Name of the resource id to use as the scope of any role assignment for the APIM system-assigned identity. A system-assigned identity has no addressable ARM resource of its own, so the service id IS that scope.')
output apimRoleAssignmentScopeId string = apimService.id

@description('Whether the developer portal was deployed. Emitted so the runbook verification checklist can assert on it rather than on a human reading a screenshot.')
output apimDeveloperPortalDeployed bool = !empty(apimService.properties.developerPortalUrl) && apimDeveloperPortalEnabled
