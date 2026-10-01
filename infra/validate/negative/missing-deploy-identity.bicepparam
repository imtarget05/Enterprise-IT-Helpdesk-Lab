// NEGATIVE TEST: a required security parameter is missing.
//
// WHY THIS MUST FAIL: `deployIdentityPrincipalId` is the principal that gets
// Contributor on both resource groups. If it were optional, a deployment with no
// value would either fail at the ARM provider or -- worse, if a default were
// added later -- grant Contributor to a principal nobody chose. A missing
// required parameter is the cheapest possible failure and it has to stay that
// way, so this fixture is expected to FAIL `bicep build-params`.
//
// If this file ever compiles, someone made a security-critical parameter
// optional. That is a hard stop, not a warning.

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

// deployIdentityPrincipalId is deliberately absent. See above.
