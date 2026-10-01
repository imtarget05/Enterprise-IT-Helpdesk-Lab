// One APIM operation plus the policy that governs it.
//
// WHY A MODULE PER OPERATION: Bicep does not allow a nested resource inside a
// resource that carries a for-expression, and it does not allow `parent:` to
// reference an element of a resource collection. Attaching N operation policies
// therefore needs one module instance per operation, with the operation and its
// policy declared together. The cost is N extra ARM requests, which is cheaper
// than an operation that silently ships without a rate limit.

targetScope = 'resourceGroup'

@description('Name of the APIM service owning the API and the operation.')
param apimServiceName string

@description('Name of the API owning the operation.')
param apiName string

@description('Unique name of the operation inside the API, e.g. "tickets" or "health".')
param operationName string

@description('Display name shown in the portal and in traces.')
param operationDisplayName string

@description('Description of what the operation does, shown to consumers.')
param operationDescription string

@description('HTTP method of the operation.')
param operationMethod string

@description('URL template relative to the API path, e.g. "/api/tickets".')
param operationUrlTemplate string

@description('True when the operation requires a valid helpdesk token. True selects operation-protected.xml; false selects operation-public.xml.')
param operationProtected bool

@description('Requests allowed per renewal window for this operation.')
param rateLimitCalls int

@description('Rate limit window in seconds for this operation.')
param rateLimitWindowSeconds int

@description('Issuer URL that validate-jwt fetches the signing keys from.')
param jwtIssuerUrl string

@description('Audience claim every accepted token must carry.')
param jwtAudience string

@description('Directory (tenant) id, pinned as the tid required claim.')
param tenantId string

resource apimService 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimServiceName
}

// The parent of an operation is the API, not the service, so the API has to be
// declared as an existing child. It is created by infra/modules/apim/
// api-surface.bicep, which this module runs inside of.
resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' existing = {
  parent: apimService
  name: apiName
}

var protectedPolicy = replace(
  replace(
    replace(
      loadTextContent('../../apim-policies/operation-protected.xml'),
      '{{JWT_ISSUER}}',
      jwtIssuerUrl
    ),
    '{{JWT_AUDIENCE}}',
    jwtAudience
  ),
  '{{TENANT_ID}}',
  tenantId
)

var publicPolicy = loadTextContent('../../apim-policies/operation-public.xml')

resource operation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: api
  name: operationName
  properties: {
    displayName: operationDisplayName
    description: operationDescription
    method: operationMethod
    urlTemplate: operationUrlTemplate
  }

  resource operationPolicy 'policies@2024-05-01' = {
    name: 'policy'
    properties: {
      format: 'rawxml'
      value: operationProtected ? replace(
        replace(
          protectedPolicy,
          '{{RATE_LIMIT_CALLS}}',
          string(rateLimitCalls)
        ),
        '{{RATE_LIMIT_WINDOW_SECONDS}}',
        string(rateLimitWindowSeconds)
      ) : replace(
        replace(
          publicPolicy,
          '{{RATE_LIMIT_CALLS}}',
          string(rateLimitCalls)
        ),
        '{{RATE_LIMIT_WINDOW_SECONDS}}',
        string(rateLimitWindowSeconds)
      )
    }
  }
}

@description('Name of the operation that was registered, for assertion in the verification step.')
output operationNameOutput string = operation.name
