// The Helpdesk API as API Management sees it: a named backend, one API bound to
// it, and an operation per portal route. Each operation carries a policy uploaded
// from infra/apim-policies/, so the routing and the throttling policy cannot
// drift apart -- an operation with no policy would have no rate limit.
//
// THE OPERATION LIST IS A PARAMETER, AND THAT IS THE POINT. Adding a portal
// route is a one-line change in the parameter file, and a route that is NOT on
// the list is unreachable through APIM. This module is built to have that
// default: the safe outcome of forgetting a route is a 404, not a new public
// endpoint.

targetScope = 'resourceGroup'

@description('Name of the APIM service that owns the API. Referenced as an existing resource: the service itself is created by infra/modules/apim/api-service.bicep in the same deployment, and Bicep `parent` can only bind to a declared resource.')
param apimServiceName string

@description('Name of the backend pointing at the helpdesk portal container app.')
param backendName string

@description('Name of the API. Becomes the path segment after the gateway host, e.g. https://<gateway>/helpdesk/api/tickets.')
param apiName string

@description('URL path prefix of the API at the gateway.')
param apiPath string

@description('Display name of the API in the portal and in traces.')
param apiDisplayName string

@description('Description of the API shown to consumers.')
param apiDescription string

@description('Base URL of the helpdesk portal container app. Becomes the backend url and the API serviceUrl.')
param containerAppUrl string

@description('Issuer URL that validate-jwt fetches the signing keys from, e.g. "https://login.microsoftonline.com/<tenant>/v2.0". Passed in rather than hardcoded so the same templates work in a sovereign cloud.')
param jwtIssuerUrl string

@description('The audience claim every accepted token must carry. The helpdesk portal audience.')
param jwtAudience string

@description('Directory (tenant) id, pinned as the tid required claim.')
param tenantId string

@description('Browser origins allowed to call the API through the gateway. Must match the portal ALLOWED_ORIGINS environment variable (internal-portal/.env.example); a mismatch shows up as a CORS error in the browser and a 200 in the gateway log.')
param allowedOrigins array

@description('API-wide rate limit in calls per minute per key. The outer envelope; per-operation limits are the inner ones and are tighter for the expensive routes.')
param apiCallsPerMinute int = 1200

@description('Operations to expose. Each entry becomes an operation plus its policy. `protected: true` applies operation-protected.xml (validate-jwt plus a per-key rate limit); false applies operation-public.xml. A portal route absent from this list returns 404 at the gateway.')
param apiOperations array

resource apimService 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimServiceName
}

var apiInboundPolicy = replace(
  replace(
    loadTextContent('../../apim-policies/api-inbound.xml'),
    '{{ALLOWED_ORIGINS}}',
    join(map(allowedOrigins, origin => '<origin>${origin}</origin>'), '\n        ')
  ),
  '{{API_CALLS_PER_MINUTE}}',
  string(apiCallsPerMinute)
)

resource backend 'Microsoft.ApiManagement/service/backends@2024-05-01' = {
  parent: apimService
  name: backendName
  properties: {
    description: 'Helpdesk portal (internal-portal) on Azure Container Apps'
    url: containerAppUrl
    // HTTPS: the portal ingress sets allowInsecure: false, so an http backend
    // would be refused by the app. These two must be changed together.
    protocol: 'https'
  }
}

resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apimService
  name: apiName
  properties: {
    path: apiPath
    displayName: apiDisplayName
    description: apiDescription
    protocols: [
      'https'
    ]
    serviceUrl: containerAppUrl
    // false: the portal authenticates its own users and does not present an
    // APIM subscription key. Enabling subscriptions would add a second,
    // independently rotatable credential to every request with no consumer.
    subscriptionRequired: false
    isCurrent: true
  }

  resource apiPolicy 'policies@2024-05-01' = {
    name: 'policy'
    properties: {
      format: 'rawxml'
      value: apiInboundPolicy
    }
  }
}

// Each operation is a module instance rather than an element of a loop on this
// resource: Bicep forbids a nested resource inside a resource with a
// for-expression, and the operation policy has to be nested inside the
// operation. See infra/modules/apim/operation.bicep for the full reason.
module operations './operation.bicep' = [
  for op in apiOperations: {
    name: 'op-${op.name}'
    params: {
      apimServiceName: apimServiceName
      apiName: apiName
      operationName: op.name
      operationDisplayName: op.displayName
      operationDescription: op.description
      operationMethod: op.method
      operationUrlTemplate: op.urlTemplate
      operationProtected: op.protected
      rateLimitCalls: op.rateLimitCalls
      rateLimitWindowSeconds: op.rateLimitWindowSeconds
      jwtIssuerUrl: jwtIssuerUrl
      jwtAudience: jwtAudience
      tenantId: tenantId
    }
  }
]

@description('Gateway URL of the API, i.e. https://<gateway>/<apiPath>. A client pointed at the Front Door host still has to be able to resolve this during CORS debugging.')
output apiGatewayUrl string = 'https://${apimService.properties.gatewayUrl}/${apiPath}'

@description('Name of the API, used by `az apim api show` in the verification checklist.')
output apiNameOutput string = api.name

@description('Names of the operations actually registered, so a verification step can assert the list rather than assume it.')
output operationNames array = map(apiOperations, op => op.name)
