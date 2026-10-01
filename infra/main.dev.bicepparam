// Helpdesk enterprise stack — DEV parameters.
//
// WHAT THIS FILE IS FOR: it makes the templates compile and the guards testable.
// It is NOT a deployment input. Every value here is either a placeholder that is
// obviously a placeholder or an operator-editable name.
//
// WHY PLACEHOLDERS AND NOT REAL VALUES. This repository is pushed to a forge. A
// real tenant id, a real resource-group name or a real principal id is
// environment-specific data that would have to be edited before first use and
// would then sit in git history forever. The zero GUID is the placeholder for
// every id: it fails the ARM lookup loudly at what-if, which is the intended
// behaviour for a value nobody has supplied yet.
//
// HOW TO PRODUCE THE REAL FILE: copy this to a path outside the repository,
// replace every value, and confirm with `git check-ignore` that the real path is
// not tracked. Validate it with `bicep build-params` before any deployment.
//
// SECRET VALUES ARE NOT IN THIS FILE AND NEVER WILL BE. postgresAdminPassword is
// the one secret-typed parameter and it is left to the deployment command to
// supply from a Key Vault reference. infra/validate.sh step 5 fails the run if a
// literal secret value appears in any template or parameter file.

using './main.bicep'

// Short environment tag. Propagated into the tag set of every resource.
param environmentName = 'dev'

// One region end to end. See the note on `location` in main.bicep.
param location = 'swedencentral'

// Zero GUID. See the header. `az account show --query tenantId -o tsv` for the
// real value.
param tenantId = '00000000-0000-0000-0000-000000000000'

// example.invalid is reserved by RFC 2606 and can never be a real mailbox, so a
// forgotten ownerContact fails loudly at delivery time instead of silently paging
// nobody.
param ownerContact = 'helpdesk-platform@example.invalid'

param dataResourceGroupName = 'rg-helpdesk-dev-data'
param appsResourceGroupName = 'rg-helpdesk-dev-apps'

param portalIdentityName = 'id-helpdesk-portal-dev'
param automationIdentityName = 'id-helpdesk-automation-dev'

// Globally unique, 3-24 alphanumeric or hyphen characters, no trailing hyphen.
param keyVaultName = 'kv-helpdesk-dev-placeholder'

// False in this baseline: a Deny default with no private endpoint locks the
// workloads out of their own secrets. infra/modules/private-endpoints exists and
// compiles; flipping this and deployPrivateEndpoints together is the private-path
// wave.
param enablePrivateNetworkForVault = false

param postgresServerName = 'pg-helpdesk-dev'
param postgresDatabaseName = 'helpdesk'
param postgresAdminUserName = 'helpdesk_admin'

// THE ONLY SECRET-typed PARAMETER IN THE STACK, and it is sourced from the
// ENVIRONMENT, never from this file. readEnvironmentVariable is a compile-time
// `bicep build-params` construct: the committed file contains no value, there is
// no literal to grep for, and a developer who exports nothing gets an empty
// string rather than a committed credential. For a real deployment, prefer a
// Key Vault reference at the command line:
//   az deployment sub create ... --parameters postgresAdminPassword=@kv-ref
// The absence of a literal here is asserted by infra/validate.sh step 5.
//   HELPDESK_POSTGRES_ADMIN_PASSWORD=<value> bicep build-params main.dev.bicepparam
// The trailing default is required by the BCP427 rule (an unset variable with no
// default is a compile error) and it is deliberately the EMPTY STRING. That means
// a developer who exports nothing still gets a valid compile and then a loud
// failure from the PostgreSQL provider on an empty admin password -- which is the
// correct failure, and much better than a committed default like 'changeme' that
// would let a deployment succeed with a guessable credential.
param postgresAdminPassword = readEnvironmentVariable('HELPDESK_POSTGRES_ADMIN_PASSWORD', '')

param redisCacheName = 'redis-helpdesk-dev'
param storageAccountName = 'sthelpdeskdevplaceholder'

// The storage surface, declared here rather than inferred from the template: five
// buckets, each with one job.
param storageContainerNames = [
  'ticket-attachments'
  'audit-exports'
  'backups'
  'automation-artifacts'
  'provisioning-scripts'
]

param serviceBusNamespaceName = 'sb-helpdesk-dev'
param automationQueueName = 'helpdesk-automation-jobs'
param automationDeadLetterQueueName = 'helpdesk-automation-dlq'

param virtualNetworkName = 'vnet-helpdesk-dev'
param virtualNetworkAddressPrefix = '10.20.0.0/16'
param containerAppsEnvironmentName = 'cae-helpdesk-dev'

param portalAppName = 'ca-helpdesk-portal-dev'
param automationAppName = 'ca-helpdesk-automation-dev'

// Both images come from this repository's own registry, built by
// .github/workflows/build-container.yml. A tag, never a digest: a digest pin
// turns every build into a template edit instead of a revision rollout.
param portalImage = 'ghcr.io/example-org/enterprise-it-helpdesk-lab/portal:dev-placeholder'
param automationImage = 'ghcr.io/example-org/enterprise-it-helpdesk-lab/llm-gateway:dev-placeholder'

param portalTargetPort = 3000
param revisionSuffix = 'v1-bootstrap'

// KEY VAULT SECRET NAMES, BY CONTRACT. Every name here is an environment variable
// that internal-portal or llm-gateway ALREADY READS. The authoritative list and
// the reasoning are in docs/enterprise-target/CONFIG-CONTRACT.md. A name that is
// not in that document is a secret that gets provisioned and never read, which is
// how a deployment silently runs with an unauthenticated gateway key.
// Values are written out of band; only names are committed.
param portalKeyVaultSecretNames = [
  'OPENAI_API_KEY'
  'MINIERP_INTEGRATION_KEY'
  'LAB_AUTH_USERS'
]

param automationKeyVaultSecretNames = [
  'LLM_CLOUD_API_KEY'
]

// Non-secret configuration for the portal. These names come from
// internal-portal/.env.example; see the contract document for the mapping.
param portalEnvironmentVariables = [
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'PORT'
    value: '3000'
  }
  {
    name: 'DATA_DIR'
    value: '/app/data'
  }
  {
    // 'lab' is the authenticated mode. 'legacy' is the no-login demo mode and
    // must not reach a shared environment.
    name: 'AUTH_MODE'
    value: 'lab'
  }
  {
    // The LLM tier the portal calls. 'ollama' points at the gateway; the gateway
    // URL comes from the same LLM_PROVIDER family the app already reads.
    name: 'LLM_PROVIDER'
    value: 'lmstudio'
  }
  {
    name: 'LMSTUDIO_URL'
    value: 'http://127.0.0.1:8787/v1'
  }
  {
    name: 'OLLAMA_TIMEOUT_MS'
    value: '8000'
  }
  {
    name: 'IT_NOTIFY_TIMEOUT_MS'
    value: '3000'
  }
  {
    // No webhook in dev: the portal writes to data/notifications.log instead,
    // which is the documented local behaviour (internal-portal/.env.example).
    name: 'IT_WEBHOOK_URL'
    value: ''
  }
]

// Non-secret configuration for the automation worker, from llm-gateway/.env.example.
param automationEnvironmentVariables = [
  {
    name: 'PORT'
    value: '8787'
  }
  {
    name: 'GATEWAY_HOST'
    value: '0.0.0.0'
  }
  {
    name: 'LLM_TIMEOUT'
    value: '120'
  }
  {
    name: 'LLM_MAX_RETRIES'
    value: '2'
  }
  {
    // VN PII masking stays on: ticket text carries phone numbers and national id
    // numbers, and the prompt leaves the LAN. See llm-gateway/automation and
    // docs/12-jd-demo-va-phong-van-python-ai.md.
    name: 'LLM_PII_MASKING'
    value: '1'
  }
  {
    name: 'LLM_QUOTA_TOKENS_PER_DAY'
    value: '0'
  }
]

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

// THE ROUTE ALLOWLIST. Every entry maps to a route that exists in
// internal-portal/src/app.js, and every route NOT listed here is unreachable
// through the gateway. `/api/audit` is deliberately absent: it exposes the audit
// trail and belongs behind an explicit decision, not behind a default. Adding it
// is a one-line change and a security review, not a default.
// probe requests/minute and seconds are the per-operation rate limit.
param apiOperations = [
  {
    name: 'health'
    displayName: 'Health'
    description: 'Liveness probe. Public by design so an uptime monitor needs no credential.'
    method: 'GET'
    urlTemplate: '/api/health'
    protected: false
    rateLimitCalls: 120
    rateLimitWindowSeconds: 60
  }
  {
    name: 'metrics'
    displayName: 'Metrics'
    description: 'Portal Prometheus metrics.'
    method: 'GET'
    urlTemplate: '/metrics'
    protected: false
    rateLimitCalls: 60
    rateLimitWindowSeconds: 60
  }
  {
    name: 'auth-login'
    displayName: 'Auth login'
    description: 'Exchange credentials for a helpdesk session token.'
    method: 'POST'
    urlTemplate: '/api/auth/login'
    protected: true
    rateLimitCalls: 10
    rateLimitWindowSeconds: 60
  }
  {
    name: 'auth-me'
    displayName: 'Auth current user'
    description: 'Resolve the session token to a user and role.'
    method: 'GET'
    urlTemplate: '/api/auth/me'
    protected: true
    rateLimitCalls: 300
    rateLimitWindowSeconds: 60
  }
  {
    name: 'tickets'
    displayName: 'Tickets'
    description: 'List and create tickets.'
    method: 'GET'
    urlTemplate: '/api/tickets'
    protected: true
    rateLimitCalls: 300
    rateLimitWindowSeconds: 60
  }
  {
    name: 'tickets-create'
    displayName: 'Create ticket'
    description: 'Create a ticket.'
    method: 'POST'
    urlTemplate: '/api/tickets'
    protected: true
    rateLimitCalls: 60
    rateLimitWindowSeconds: 60
  }
  {
    name: 'ticket-detail'
    displayName: 'Ticket detail'
    description: 'One ticket with its timeline and work notes.'
    method: 'GET'
    urlTemplate: '/api/tickets/{id}'
    protected: true
    rateLimitCalls: 300
    rateLimitWindowSeconds: 60
  }
  {
    name: 'assets'
    displayName: 'IT assets'
    description: 'List and create IT assets.'
    method: 'GET'
    urlTemplate: '/api/assets'
    protected: true
    rateLimitCalls: 300
    rateLimitWindowSeconds: 60
  }
  {
    name: 'assets-export'
    displayName: 'Export assets'
    description: 'CSV export of the asset register.'
    method: 'GET'
    urlTemplate: '/api/assets/export.csv'
    protected: true
    // Lower than the read routes: an export scans the whole register and writes
    // a blob, so it is the expensive one.
    rateLimitCalls: 20
    rateLimitWindowSeconds: 60
  }
  {
    name: 'dashboard-stats'
    displayName: 'Dashboard statistics'
    description: 'Aggregated counts for the dashboard.'
    method: 'GET'
    urlTemplate: '/api/dashboard/stats'
    protected: true
    rateLimitCalls: 120
    rateLimitWindowSeconds: 60
  }
  {
    name: 'access-requests'
    displayName: 'Access requests'
    description: 'List access requests and their approval state.'
    method: 'GET'
    urlTemplate: '/api/access-requests'
    protected: true
    rateLimitCalls: 120
    rateLimitWindowSeconds: 60
  }
  {
    name: 'access-request-approve'
    displayName: 'Approve access request'
    description: 'Approve an access request. HIGH_RISK in llm-gateway/automation/policy.py terms when driven by automation.'
    method: 'POST'
    urlTemplate: '/api/access-requests/{id}/approve'
    protected: true
    rateLimitCalls: 30
    rateLimitWindowSeconds: 60
  }
  {
    name: 'tickets-export'
    displayName: 'Export tickets'
    description: 'CSV export of the ticket register.'
    method: 'GET'
    urlTemplate: '/api/tickets/export.csv'
    protected: true
    rateLimitCalls: 20
    rateLimitWindowSeconds: 60
  }
]

param frontDoorResourceNames = {
  profile: 'fd-helpdesk-dev'
  endpoint: 'fde-helpdesk-dev'
  originGroup: 'fdog-helpdesk-dev'
  origin: 'fdo-helpdesk-dev'
  route: 'fdr-helpdesk-dev'
  wafPolicy: 'waf-helpdesk-dev'
  securityPolicy: 'fdsec-helpdesk-dev'
}

// Empty in this baseline. See the parameter description in main.bicep for why
// these are ids and why the module does not create the zones.
param privateDnsZoneResourceIds = {
  keyVault: ''
  postgres: ''
  redis: ''
  blob: ''
  serviceBus: ''
}

param deployPrivateEndpoints = false

// Zero GUID. See the header. `az ad sp show --id <appId> --query id -o tsv` on the
// federated identity for the real value. Leaving this as the zero GUID means a
// deployment that forgets to supply it grants Contributor to nobody and fails
// loudly, which is the correct failure.
param deployIdentityPrincipalId = '00000000-0000-0000-0000-000000000000'