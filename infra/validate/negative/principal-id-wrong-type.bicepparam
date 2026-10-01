// NEGATIVE TEST: a type violation on a security-critical parameter.
//
// WHY THIS MUST FAIL: `deployIdentityPrincipalId` is fed straight into
// `principalId` on a Contributor role assignment for both resource groups. A
// number where a GUID object id belongs is the kind of mistake that either fails
// at the provider or -- if the type were loosened to `any` -- produces a role
// assignment with a garbage principal. The type system is the guard here, so this
// fixture proves the guard is still in place.
//
// If this file ever compiles, the parameter type was weakened. Hard stop.

using '../../main.bicep'

param environmentName = 'dev'
param location = 'swedencentral'
param tenantId = '00000000-0000-0000-0000-000000000000'
param ownerContact = 'helpdesk-platform@example.invalid'
param dataResourceGroupName = 'rg-helpdesk-dev-data'
param appsResourceGroupName = 'rg-helpdesk-dev-apps'
param portalIdentityName = 'id-helpdesk-portal-dev'
param automationIdentityName = 'id-helpdesk-automation-dev'
param keyVaultName = 'kv-helpdesk-dev-placeholder'
param enablePrivateNetworkForVault = false
param postgresServerName = 'pg-helpdesk-dev'
param postgresDatabaseName = 'helpdesk'
param postgresAdminUserName = 'helpdesk_admin'
param postgresAdminPassword = readEnvironmentVariable('HELPDESK_POSTGRES_ADMIN_PASSWORD', '')
param redisCacheName = 'redis-helpdesk-dev'
param storageAccountName = 'sthelpdeskdevplaceholder'
param storageContainerNames = [
  'ticket-attachments'
  'audit-exports'
  'backups'
]
param serviceBusNamespaceName = 'sb-helpdesk-dev'
param automationQueueName = 'helpdesk-automation-jobs'
param automationDeadLetterQueueName = 'helpdesk-automation-dlq'
param virtualNetworkName = 'vnet-helpdesk-dev'
param virtualNetworkAddressPrefix = '10.20.0.0/16'
param containerAppsEnvironmentName = 'cae-helpdesk-dev'
param portalAppName = 'ca-helpdesk-portal-dev'
param automationAppName = 'ca-helpdesk-automation-dev'
param portalImage = 'ghcr.io/example-org/enterprise-it-helpdesk-lab/portal:dev-placeholder'
param automationImage = 'ghcr.io/example-org/enterprise-it-helpdesk-lab/llm-gateway:dev-placeholder'
param portalTargetPort = 3000
param revisionSuffix = 'v1-bootstrap'
param portalKeyVaultSecretNames = [
  'OPENAI_API_KEY'
]
param automationKeyVaultSecretNames = []
param portalEnvironmentVariables = []
param automationEnvironmentVariables = []
param logAnalyticsWorkspaceName = 'log-helpdesk-dev'
param applicationInsightsName = 'appi-helpdesk-dev'
param apimResourceNames = {
  service: 'apim-helpdesk-dev'
  backend: 'helpdesk-portal-backend'
  api: 'helpdesk-api'
  apiPath: 'helpdesk'
}
param apimSkuName = 'Developer'
param apimVirtualNetworkType = 'None'
param apiOperations = []
param frontDoorResourceNames = {
  profile: 'fd-helpdesk-dev'
  endpoint: 'fde-helpdesk-dev'
  originGroup: 'fdog-helpdesk-dev'
  origin: 'fdo-helpdesk-dev'
  route: 'fdr-helpdesk-dev'
  wafPolicy: 'waf-helpdesk-dev'
  securityPolicy: 'fdsec-helpdesk-dev'
}
param deployPrivateEndpoints = false

// Wrong type on purpose: an int where a string object id is required.
param deployIdentityPrincipalId = 12345
