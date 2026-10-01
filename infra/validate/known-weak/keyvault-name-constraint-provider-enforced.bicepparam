// CLOSED GAP — the Key Vault property checks now exist, and this file is kept as
// the regression pin for a gap that is still open.
//
// HISTORY, kept because the evidence trail matters more than a tidy file. The
// bootstrap source for this repository ran a full IaC validation suite with
// `enablePurgeProtection: false` in its Key Vault module and every check still
// reported success. Nothing inspected resource properties, so a security property
// could be turned off and the job stayed green. That was run, not assumed.
//
// THE FIX, in this repository: infra/scripts/check_invariants.py compiles
// main.bicep to ARM JSON and asserts the security invariants on that artifact,
// including enablePurgeProtection and enableRbacAuthorization on every Key Vault,
// plus the invariants listed in that file for the other data-tier resources.
//
// THE GAP THAT REMAINS, AND IS NOT COVERED BY AN AUTOMATED CHECK:
// `param keyVaultName string` accepts any string, while the real constraint
// (3-24 alphanumeric and hyphen characters, no trailing hyphen) is enforced by
// the ARM provider at deployment time rather than at compile time. This file
// compiles with a deliberately invalid-looking name fragment, which is the proof
// that the constraint is still provider-enforced only.
//
// Fixing it means moving the constraint into a Bicep `assert` and enabling the
// Asserts experimental feature, which is a deliberate decision rather than a
// validator change. Delete this fixture when the name constraint is asserted in
// the template itself.

using '../../main.bicep'

param environmentName = 'dev'
param location = 'swedencentral'
param tenantId = '00000000-0000-0000-0000-000000000000'
param ownerContact = 'helpdesk-platform@example.invalid'
param dataResourceGroupName = 'rg-helpdesk-dev-data'
param appsResourceGroupName = 'rg-helpdesk-dev-apps'
param portalIdentityName = 'id-helpdesk-portal-dev'
param automationIdentityName = 'id-helpdesk-automation-dev'
// Not a legal Key Vault name (underscores, and it exceeds the 24-character limit).
// The point of this fixture: Bicep accepts it.
param keyVaultName = 'THIS_IS_NOT_A_LEGAL_KEY_VAULT_NAME_AT_ALL'
param enablePrivateNetworkForVault = false
param postgresServerName = 'pg-helpdesk-dev'
param postgresDatabaseName = 'helpdesk'
param postgresAdminUserName = 'helpdesk_admin'
param postgresAdminPassword = readEnvironmentVariable('HELPDESK_POSTGRES_ADMIN_PASSWORD', '')
param redisCacheName = 'redis-helpdesk-dev'
param storageAccountName = 'sthelpdeskdevplaceholder'
param storageContainerNames = [
  'ticket-attachments'
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
param deployIdentityPrincipalId = '00000000-0000-0000-0000-000000000000'
