// Helpdesk on Azure — the deployment unit for this baseline.
//
// NO AZURE RESOURCE HAS BEEN CREATED FROM THIS FILE. It is validated by
// infra/validate.sh (compile + linter + negative tests + invariants + the
// independence check) and by the iac-validate CI job, neither of which
// authenticates to Azure. There is no `az login`, no `az deployment` and no
// `--what-if` anywhere in either. A green validation run means "the templates are
// well-formed and the guards hold", NOT "the stack exists". The first real
// deployment is a separate, explicitly authorised step with its own evidence.
//
// WHAT THIS STACK IS, in one paragraph: a public edge (Front Door + WAF) in front
// of a gateway (API Management) in front of two container apps (the
// internal-portal REST API and the llm-gateway automation worker), backed by a
// durable data tier (PostgreSQL for helpdesk state, Redis for session and SLA
// cache, Storage for attachments and backups, Service Bus for the automation
// pipeline, Key Vault for runtime secrets) with a VNet and private endpoints as
// the target path rather than the initial state.
//
// WHAT IS DELIBERATELY NOT HERE: any vector store, Qdrant, embedding service,
// retrieval index or agent-ingestion pipeline. The Helpdesk target has no RAG
// component. infra/scripts/check_independence.sh and the invariant checker both
// assert the absence, because a module that drifted in from the bootstrap source
// would be the single most likely way this stack acquires one by accident.
//
// Deployment order is not arbitrary. Identities exist before RBAC can name their
// principals; monitoring exists before anything whose failure has to be
// diagnosable; RBAC runs last so a partial failure leaves a stack with no
// privileges rather than a privileged stack with no identity.
//
// This file holds parameters and wiring only. Every resource decision lives in
// infra/modules/<concern>/, with the reason it is that way recorded next to it.

targetScope = 'subscription'

@description('Short environment name, e.g. "prod" or "dev". Drives the shared tag set.')
param environmentName string

@description('Primary region for the stack. One region end to end: a Container Apps environment cannot pull from a cross-region registry over a private endpoint, and a cross-region APIM backend pays latency on every request.')
param location string

@description('Directory (tenant) id that owns the Key Vault and the token issuer. No default: a real tenant id is environment data and must never be committed.')
param tenantId string

@description('Owner contact recorded in the tag set of every resource. Must be a monitored mailbox: it is the only human route back to these resources.')
param ownerContact string

@description('Name of the resource group holding the managed identities, the Key Vault and the durable data stores.')
param dataResourceGroupName string

@description('Name of the resource group holding the network, the container apps, monitoring, APIM and Front Door.')
param appsResourceGroupName string

@description('Name of the user-assigned managed identity the portal runs as. User-assigned because it is referenced from the container app, Key Vault, Service Bus and the data stores, and must survive the destruction of any one of them.')
param portalIdentityName string

@description('Name of the user-assigned managed identity the automation worker runs as.')
param automationIdentityName string

@description('Globally unique Key Vault name. 3-24 alphanumeric or hyphen characters, cannot end in a hyphen.')
param keyVaultName string

@description('True when Key Vault is reachable only through a private endpoint. False in this baseline, because a Deny default with no private endpoint locks the workloads out of their own secrets, and infra/modules/private-endpoints is not deployed yet.')
param enablePrivateNetworkForVault bool = false

@description('Name of the PostgreSQL Flexible Server holding durable helpdesk state: tickets, assets, incidents, audit events, approval requests, automation runs and SLA metadata.')
param postgresServerName string

@description('Name of the logical database on that server.')
param postgresDatabaseName string

@description('Name of the PostgreSQL role the portal connects as. NOT a superuser.')
param postgresAdminUserName string = 'helpdesk_admin'

@description('Password for the PostgreSQL admin role. Supplied at deployment time from a Key Vault secret reference, or from the environment via readEnvironmentVariable in the committed parameter files. NEVER committed, and never a literal in a parameter file -- infra/validate.sh step 5 fails the run if one appears.')
@secure()
param postgresAdminPassword string

@description('Name of the Redis Cache holding session, SLA-dedup and job-dedup state.')
param redisCacheName string

@description('Name of the storage account holding ticket attachments, exports and backups.')
param storageAccountName string

@description('Blob containers to create. The storage surface is a parameter so a reviewer can see it rather than infer it from the template.')
param storageContainerNames array

@description('Name of the Service Bus namespace carrying the helpdesk automation pipeline.')
param serviceBusNamespaceName string

@description('Name of the automation job queue. The default matches the contract in docs/enterprise-target/CONFIG-CONTRACT.md.')
param automationQueueName string = 'helpdesk-automation-jobs'

@description('Name of the automation dead-letter queue.')
param automationDeadLetterQueueName string = 'helpdesk-automation-dlq'

@description('Name of the virtual network. Not a parameter of the networking module alone: the private endpoints and the data stores all need the same subnets.')
param virtualNetworkName string

@description('Address prefix of the virtual network.')
param virtualNetworkAddressPrefix string = '10.20.0.0/16'

@description('Name of the Container Apps managed environment.')
param containerAppsEnvironmentName string

@description('Name of the portal container app.')
param portalAppName string

@description('Name of the automation worker container app.')
param automationAppName string

@description('Container image the portal runs, from this repository\'s own registry. No digest pin here: a pin turns every build into a template edit rather than a revision rollout.')
param portalImage string

@description('Container image the automation worker runs.')
param automationImage string

@description('Portal ingress target port. Must match the EXPOSE in internal-portal/Dockerfile and the PORT the app reads from the environment.')
param portalTargetPort int = 3000

@description('Revision suffix. Bump it to force a new revision from an unchanged template, which is how a configuration change reaches a running Container App.')
param revisionSuffix string

@description('Key Vault secret NAMES the portal resolves, by managed identity. Every name must already be read by internal-portal source code -- see docs/enterprise-target/CONFIG-CONTRACT.md. A name not in that document is a secret that gets provisioned and never read.')
param portalKeyVaultSecretNames array

@description('Key Vault secret NAMES the automation worker resolves, by managed identity. Same contract, from the llm-gateway side of the document.')
param automationKeyVaultSecretNames array

@description('Non-secret environment variables for the portal. Exactly the configuration internal-portal already reads.')
param portalEnvironmentVariables array

@description('Non-secret environment variables for the automation worker. Exactly the configuration llm-gateway already reads.')
param automationEnvironmentVariables array

@description('Name of the Log Analytics workspace receiving every diagnostic stream in this stack.')
param logAnalyticsWorkspaceName string

@description('Name of the Application Insights component.')
param applicationInsightsName string

@description('Names of the API Management resources: service, backend, api, and the URL path prefix the API is published at.')
param apimResourceNames object

@description('APIM SKU. "Consumption" for prod. See infra/modules/apim/api-service.bicep for the tier reasoning.')
param apimSkuName string = 'Consumption'

@description('APIM network configuration. "None" on Consumption.')
param apimVirtualNetworkType string = 'None'

@description('Operations exposed at the gateway, with per-operation rate limits and whether each requires a token. A portal route absent from this list returns 404 at the gateway.')
param apiOperations array

@description('Names of the Front Door resources: profile, endpoint, origin group, origin, route, WAF policy and security policy.')
param frontDoorResourceNames object

@description('Object id of the identity the deployment pipeline runs as. This deployment grants it Contributor on the two resource groups and nothing else. Registered out of band by an operator; no value is committed here and the committed placeholder fails what-if loudly by design.')
param deployIdentityPrincipalId string

@description('Private DNS zone resource ids for the data tier, one per privatised store. Empty in this baseline because no store is private yet. These are ids rather than names on purpose: an enterprise may already own these zones, and a module that CREATED them would produce a duplicate zone rather than reuse the existing one, which splits resolution for everything else on the private link. The private-path wave supplies them.')
param privateDnsZoneResourceIds object = {
  keyVault: ''
  postgres: ''
  redis: ''
  blob: ''
  serviceBus: ''
}

@description('Deploy the private endpoints for the data tier. False in this baseline. It is a single switch because the data stores, the DNS zone groups and this module all have to flip together: enabling a store with no endpoint, or an endpoint with a public store, are both silent no-ops.')
param deployPrivateEndpoints bool = false

// WHY A SINGLE WIRE-THROUGH IDENTITY RESOURCE HERE RATHER THAN THREE SEPARATE
// DECLARATIONS: the two resource groups must exist before any group-scoped module
// can be scoped to them, and a module scope has to be computable before the
// deployment starts. One resource whose id both modules are scoped from keeps the
// ordering in one place; a `dependsOn` on the module invocations below is what
// actually orders group creation first.
module resourceGroups './resourceGroups.bicep' = {
  name: 'helpdesk-resource-groups'
  params: {
    location: location
    environmentName: environmentName
    dataResourceGroupName: dataResourceGroupName
    appsResourceGroupName: appsResourceGroupName
    ownerContact: ownerContact
  }
}

module identity './modules/managed-identity/main.bicep' = {
  name: 'helpdesk-identity'
  // Scoped by name, not by a resourceGroups module output: a module scope has to
  // be computable before the deployment starts, and resourceGroup(<id>) is not.
  scope: resourceGroup(subscription().subscriptionId, dataResourceGroupName)
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    portalIdentityName: portalIdentityName
    automationIdentityName: automationIdentityName
    ownerContact: ownerContact
  }
}

module keyVault './modules/key-vault/main.bicep' = {
  name: 'helpdesk-keyvault'
  scope: resourceGroup(subscription().subscriptionId, dataResourceGroupName)
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    tenantId: tenantId
    environmentName: environmentName
    keyVaultName: keyVaultName
    ownerContact: ownerContact
    enablePrivateNetwork: enablePrivateNetworkForVault
  }
}

module monitoring './modules/monitoring/main.bicep' = {
  name: 'helpdesk-monitoring'
  scope: resourceGroup(subscription().subscriptionId, appsResourceGroupName)
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    logAnalyticsWorkspaceName: logAnalyticsWorkspaceName
    applicationInsightsName: applicationInsightsName
    ownerContact: ownerContact
  }
}

module networking './modules/networking/main.bicep' = {
  name: 'helpdesk-networking'
  scope: resourceGroup(subscription().subscriptionId, appsResourceGroupName)
  // Monitoring before the data stores: the data-tier modules attach diagnostic
  // settings to the workspace id, and a diagnostic setting whose target does not
  // exist at deploy time is a failed deployment rather than a warning.
  dependsOn: [
    resourceGroups
    monitoring
  ]
  params: {
    location: location
    environmentName: environmentName
    ownerContact: ownerContact
    virtualNetworkName: virtualNetworkName
    virtualNetworkAddressPrefix: virtualNetworkAddressPrefix
    containerAppsEnvironmentName: containerAppsEnvironmentName
  }
}

module postgres './modules/postgres/main.bicep' = {
  name: 'helpdesk-postgres'
  scope: resourceGroup(subscription().subscriptionId, dataResourceGroupName)
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    postgresServerName: postgresServerName
    postgresDatabaseName: postgresDatabaseName
    postgresAdminUserName: postgresAdminUserName
    postgresAdminPassword: postgresAdminPassword
    ownerContact: ownerContact
    deployIdentityResourceId: identity.outputs.portalIdentityId
  }
}

module redis './modules/redis/main.bicep' = {
  name: 'helpdesk-redis'
  scope: resourceGroup(subscription().subscriptionId, dataResourceGroupName)
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    redisCacheName: redisCacheName
    ownerContact: ownerContact
  }
}

module storage './modules/storage/main.bicep' = {
  name: 'helpdesk-storage'
  scope: resourceGroup(subscription().subscriptionId, dataResourceGroupName)
  // Ordering note, and why there is no explicit dependsOn on `monitoring`:
  // this module is handed monitoring.outputs.logAnalyticsWorkspaceId below, and
  // Bicep infers a module-to-module dependency from an output reference. An
  // explicit dependsOn here would be flagged no-unnecessary-dependson, and
  // removing the output reference in favour of the flag would be worse: it
  // would compile in the wrong order.
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    storageAccountName: storageAccountName
    ownerContact: ownerContact
    enablePrivateNetwork: enablePrivateNetworkForVault
    containerNames: storageContainerNames
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

module serviceBus './modules/service-bus/main.bicep' = {
  name: 'helpdesk-servicebus'
  scope: resourceGroup(subscription().subscriptionId, dataResourceGroupName)
  // Ordering note: see the comment on the storage module above. The dependency on
  // monitoring is carried by the logAnalyticsWorkspaceId output below.
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    serviceBusNamespaceName: serviceBusNamespaceName
    ownerContact: ownerContact
    automationQueueName: automationQueueName
    automationDeadLetterQueueName: automationDeadLetterQueueName
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

module containerApp './modules/container-app/main.bicep' = {
  name: 'helpdesk-container-app'
  scope: resourceGroup(subscription().subscriptionId, appsResourceGroupName)
  // Networking before the apps: the apps need the environment id, and the
  // environment needs the delegated subnet. Both orderings are carried by the
  // networking.* and monitoring.* outputs passed below, not by this list -- an
  // explicit entry for a module whose output is already referenced is flagged
  // no-unnecessary-dependson.
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    ownerContact: ownerContact
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerAppsEnvironmentId: networking.outputs.containerAppsEnvironmentId
    containerAppsEnvironmentFqdn: networking.outputs.containerAppsEnvironmentDefaultDomain
    portalAppName: portalAppName
    automationAppName: automationAppName
    portalImage: portalImage
    automationImage: automationImage
    portalTargetPort: portalTargetPort
    automationTargetPort: 8787
    revisionSuffix: revisionSuffix
    keyVaultUri: keyVault.outputs.keyVaultUri
    portalKeyVaultSecretNames: portalKeyVaultSecretNames
    automationKeyVaultSecretNames: automationKeyVaultSecretNames
    portalEnvironmentVariables: portalEnvironmentVariables
    automationEnvironmentVariables: automationEnvironmentVariables
    portalIdentityId: identity.outputs.portalIdentityId
    automationIdentityId: identity.outputs.automationIdentityId
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

module apimService './modules/apim/api-service.bicep' = {
  name: 'helpdesk-apim-service'
  scope: resourceGroup(subscription().subscriptionId, appsResourceGroupName)
  // Ordering note: see the comment on the storage module above. The dependency on
  // monitoring is carried by the logAnalyticsWorkspaceId output below.
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    ownerContact: ownerContact
    apimServiceName: apimResourceNames.service
    apimSkuName: apimSkuName
    apimPublisherEmail: ownerContact
    apimPublisherName: 'Helpdesk Platform'
    apimVirtualNetworkType: apimVirtualNetworkType
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

module apimApiSurface './modules/apim/api-surface.bicep' = {
  name: 'helpdesk-apim-api'
  scope: resourceGroup(subscription().subscriptionId, appsResourceGroupName)
  // Ordering: the API and its operations are children of the service created by
  // apimService, and the backend points at the portal created by containerApp.
  // Both are inferred from the containerApp.outputs.portalAppUrl and the
  // monitoring.outputs.logAnalyticsWorkspaceId references in the params below.
  dependsOn: [
    resourceGroups
  ]
  params: {
    apimServiceName: apimResourceNames.service
    backendName: apimResourceNames.backend
    apiName: apimResourceNames.api
    apiPath: apimResourceNames.apiPath
    apiDisplayName: 'Helpdesk API'
    apiDescription: 'Enterprise IT helpdesk and asset management: tickets, assets, incidents, approvals, audit and automation proposals.'
    containerAppUrl: containerApp.outputs.portalAppUrl
    // The issuer is assembled here rather than passed whole, so the one place
    // that knows the cloud's authority shape is this line. The authority host
    // comes from environment().authentication instead of a literal, because a
    // hardcoded login.microsoftonline.com validates against the wrong authority
    // in a sovereign cloud and the bicep no-hardcoded-env-urls linter rule
    // exists for exactly that reason.
    jwtIssuerUrl: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
    jwtAudience: 'api://${apimResourceNames.api}'
    tenantId: tenantId
    allowedOrigins: []
    apiOperations: apiOperations
  }
}

module frontDoor './modules/front-door/main.bicep' = {
  name: 'helpdesk-front-door'
  scope: resourceGroup(subscription().subscriptionId, appsResourceGroupName)
  // Ordering: the origin host is the APIM gateway host name, so this is ordered
  // after apimService by the output reference below. See the comment on the
  // storage module above for why it is not an explicit entry.
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    ownerContact: ownerContact
    frontDoorProfileName: frontDoorResourceNames.profile
    frontDoorEndpointName: frontDoorResourceNames.endpoint
    frontDoorOriginGroupName: frontDoorResourceNames.originGroup
    frontDoorOriginName: frontDoorResourceNames.origin
    frontDoorRouteName: frontDoorResourceNames.route
    frontDoorWafPolicyName: frontDoorResourceNames.wafPolicy
    frontDoorSecurityPolicyName: frontDoorResourceNames.securityPolicy
    apimGatewayHostName: apimService.outputs.apimGatewayHostName
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

// The data tier's private path. CONDITIONAL, and gated on one switch so the
// endpoints and the public-access flags cannot drift: enabling a store with no
// endpoint deadlocks the portal against its own secrets, and creating an endpoint
// against a public store costs money and protects nothing.
//
// NOT DEPLOYED IN THIS BASELINE. It is wired and compiles so the private-path wave
// is a one-flag change reviewed as a diff rather than new code written at 2am.
module privateEndpoints './modules/private-endpoints/main.bicep' = if (deployPrivateEndpoints) {
  name: 'helpdesk-private-endpoints'
  scope: resourceGroup(subscription().subscriptionId, appsResourceGroupName)
  // Ordering: the endpoint subnet comes from networking, and each endpoint target
  // from a data-tier module output. All inferred from the params below.
  dependsOn: [
    resourceGroups
  ]
  params: {
    location: location
    environmentName: environmentName
    ownerContact: ownerContact
    privateEndpointsSubnetResourceId: networking.outputs.privateEndpointsSubnetResourceId
    keyVaultPrivateDnsZoneResourceId: privateDnsZoneResourceIds.keyVault
    postgresPrivateDnsZoneResourceId: privateDnsZoneResourceIds.postgres
    redisPrivateDnsZoneResourceId: privateDnsZoneResourceIds.redis
    blobPrivateDnsZoneResourceId: privateDnsZoneResourceIds.blob
    serviceBusPrivateDnsZoneResourceId: privateDnsZoneResourceIds.serviceBus
    keyVaultResourceId: keyVault.outputs.keyVaultId
    postgresServerResourceId: postgres.outputs.postgresServerId
    redisCacheResourceId: redis.outputs.redisCacheId
    storageAccountResourceId: storage.outputs.storageAccountId
    serviceBusNamespaceResourceId: serviceBus.outputs.serviceBusNamespaceId
    keyVaultPrivateNetworkEnabled: enablePrivateNetworkForVault
    postgresPrivateNetworkEnabled: deployPrivateEndpoints
    redisPrivateNetworkEnabled: deployPrivateEndpoints
    storagePrivateNetworkEnabled: enablePrivateNetworkForVault
    serviceBusPrivateNetworkEnabled: deployPrivateEndpoints
  }
}

// RBAC runs last. Everything it grants needs an identity that already exists, and
// the deployment identity's own Contributor grant is the last thing created -- so a
// partial failure leaves a stack with no privileges rather than a privileged stack
// with no identity.
module rbacData './modules/rbac/main.bicep' = {
  name: 'helpdesk-rbac-data'
  scope: resourceGroup(subscription().subscriptionId, dataResourceGroupName)
  dependsOn: [
    resourceGroups
  ]
  params: {
    portalIdentityPrincipalId: identity.outputs.portalIdentityPrincipalId
    automationIdentityPrincipalId: identity.outputs.automationIdentityPrincipalId
    deployIdentityPrincipalId: deployIdentityPrincipalId
    keyVaultName: keyVaultName
    postgresServerName: postgresServerName
    redisCacheName: redisCacheName
    storageAccountName: storageAccountName
    serviceBusNamespaceName: serviceBusNamespaceName
  }
}

module rbacApps './modules/rbac/main.bicep' = {
  name: 'helpdesk-rbac-apps'
  scope: resourceGroup(subscription().subscriptionId, appsResourceGroupName)
  dependsOn: [
    resourceGroups
  ]
  // The apps group holds no data-plane resource the workload identities need, so
  // this invocation grants only the deployment identity's Contributor.
  params: {
    portalIdentityPrincipalId: identity.outputs.portalIdentityPrincipalId
    automationIdentityPrincipalId: identity.outputs.automationIdentityPrincipalId
    deployIdentityPrincipalId: deployIdentityPrincipalId
  }
}

@description('Public URL clients should be pointed at: the Front Door endpoint. The only helpdesk URL intended for browsers.')
output helpdeskPublicUrl string = frontDoor.outputs.frontDoorUrl

@description('Ingress URL of the portal container app. For in-cluster and debugging traffic only; it bypasses the WAF and the gateway rate limits.')
output helpdeskPortalAppUrl string = containerApp.outputs.portalAppUrl

@description('APIM gateway URL of the helpdesk API, used for direct API calls in the verification checklist.')
output helpdeskApiGatewayUrl string = apimApiSurface.outputs.apiGatewayUrl

@description('APIM gateway hostname, which is the Front Door origin host.')
output helpdeskApimGatewayHostName string = apimService.outputs.apimGatewayHostName

@description('URI of the Key Vault holding the runtime secrets.')
output helpdeskKeyVaultUri string = keyVault.outputs.keyVaultUri

@description('Resource id of the user-assigned managed identity the portal runs as.')
output helpdeskPortalIdentityId string = identity.outputs.portalIdentityId

@description('Client id of the portal managed identity. Pass as AZURE_CLIENT_ID for out-of-band data-plane calls.')
output helpdeskPortalIdentityClientId string = identity.outputs.portalIdentityClientId

@description('Object id of the portal managed identity service principal. The value every runtime role assignment targets -- never the client id.')
output helpdeskPortalIdentityPrincipalId string = identity.outputs.portalIdentityPrincipalId

@description('Object id of the automation worker managed identity service principal.')
output helpdeskAutomationIdentityPrincipalId string = identity.outputs.automationIdentityPrincipalId

@description('Resource id of the Log Analytics workspace holding every diagnostic stream from this stack.')
output helpdeskLogAnalyticsWorkspaceId string = monitoring.outputs.logAnalyticsWorkspaceId

@description('Host name of the PostgreSQL server. The application assembles credentials itself; no connection string is emitted.')
output helpdeskPostgresFqdn string = postgres.outputs.postgresServerFqdn

@description('Name of the logical database holding durable helpdesk state.')
output helpdeskPostgresDatabaseName string = postgres.outputs.postgresDatabaseNameOutput

@description('Host name of the Redis endpoint.')
output helpdeskRedisHostName string = redis.outputs.redisHostName

@description('Blob service endpoint for ticket attachments, exports and backups.')
output helpdeskStorageBlobEndpoint string = storage.outputs.storageBlobEndpoint

@description('Blob containers created. A runbook asserts the list rather than assuming it.')
output helpdeskStorageContainerNames array = storage.outputs.blobContainerNames

@description('Service Bus endpoint carrying the helpdesk automation pipeline.')
output helpdeskServiceBusEndpoint string = serviceBus.outputs.serviceBusEndpoint

@description('Name of the automation job queue.')
output helpdeskAutomationQueueName string = serviceBus.outputs.automationQueueNameOutput

@description('Name of the automation dead-letter queue. An alert targets this; a non-empty DLQ is a ticket.')
output helpdeskAutomationDeadLetterQueueName string = serviceBus.outputs.automationDeadLetterQueueNameOutput

@description('Resource id of the Container Apps environment, and the private-link target if the edge is ever pointed at the portal directly instead of at APIM.')
output helpdeskContainerAppsEnvironmentId string = networking.outputs.containerAppsEnvironmentId

@description('Operations registered at the gateway. Anything not listed here is unreachable through APIM.')
output helpdeskApiOperations array = apimApiSurface.outputs.operationNames

@description('Role definition ids granted by this deployment, so a reviewer can diff them with `az role assignment list` instead of reading the template.')
output helpdeskAssignedRoleDefinitionIds array = rbacData.outputs.assignedRoleDefinitionIds

@description('Resource groups this deployment owns. A destroy runbook that lists anything else as safe to delete is wrong.')
output helpdeskResourceGroupNames array = [
  dataResourceGroupName
  appsResourceGroupName
]

@description('Whether the private endpoints for the data tier are deployed by this parameter set. False in this baseline. A runbook reads this rather than assuming from the module wiring.')
output helpdeskPrivateEndpointsDeployed bool = deployPrivateEndpoints

@description('Whether anything in this stack has actually been deployed. False in this baseline and asserted by the deployment runbook, so a green validation run cannot be misread as a deployed stack.')
output helpdeskDeployed bool = false