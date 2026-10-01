// The Helpdesk container apps: the portal and the automation worker.
//
// TWO APPS, ONE ENVIRONMENT, BECAUSE THEY ARE ONE DEPLOYMENT UNIT WITH DIFFERENT
// IDENTITIES AND DIFFERENT TRUST:
//   ca-helpdesk-portal   internal-portal/server.js -- the REST API and dashboard
//   ca-helpdesk-automation  the llm-gateway / automation consumer -- decides and
//                        executes approved automation actions
//
// WHY TWO AND NOT ONE: llm-gateway/automation/policy.py gates HIGH_RISK actions
// (new_company_user, disable_company_user, restore_helpdesk_data) behind
// requires_approval(), and executor.py is the only component that builds
// PowerShell argv. Collapsing them puts the LLM upstream and the script runner in
// one process again, which is the trust boundary the split exists to hold. The
// automation app also gets no LLM upstream credentials at all.
//
// WHAT IS IN THE CONTAINER: the internal-portal image and the llm-gateway image
// built by this repo's own CI. No image is published by this template, and no
// digest is pinned here: pinning would turn every build into a template edit
// rather than a revision rollout, and the tag is re-resolved on each revision.

targetScope = 'resourceGroup'

@description('Deployment region for the environment and both apps.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Owner contact recorded on every resource here.')
param ownerContact string

@description('Name of the Container Apps managed environment. Not used directly today -- the environment is created by infra/modules/networking -- but emitted so a runbook can name it without reading the network template.')
param containerAppsEnvironmentName string

@description('Name of the workload profile the portal and the automation worker are placed on.')
param workloadProfileName string = 'default'

@description('Name of the portal container app.')
param portalAppName string

@description('Name of the automation worker container app.')
param automationAppName string

@description('Container image the portal runs. Supplied by the parameter file from this repo\'s own registry.')
param portalImage string

@description('Container image the automation worker runs.')
param automationImage string

@description('Portal container name inside the revision. Keyed on by the Container Apps log stream and the App Insights container field.')
param portalContainerName string = 'helpdesk-portal'

@description('Automation worker container name inside the revision.')
param automationContainerName string = 'helpdesk-automation'

@description('Portal container memory ceiling. 1Gi is the tuned size for the Express + local-RAG image; below it the portal is OOM-killed during startup, and an OOM during model load surfaces as a crash loop with no probe failure.')
param portalMemory string = '1Gi'

@description('Portal container vCPU as a JSON number string. See the note on the json() call below for why this is a string parameter.')
param portalVcpu string = '1.0'

@description('Automation worker memory ceiling. The worker loads the LLM provider and the automation policy tables, and runs a subprocess per action.')
param automationMemory string = '1Gi'

@description('Automation worker vCPU as a JSON number string.')
param automationVcpu string = '1.0'

@description('Minimum replicas for the portal. 1 keeps it warm; 0 makes the first request after idle pay a cold start.')
param portalMinReplicas int = 1

@description('Maximum replicas for the portal. 5 is a cost ceiling, not a throughput target.')
param portalMaxReplicas int = 5

@description('Minimum replicas for the automation worker. 0 is correct here: a consumer that is always up has no jobs to consume between polls and exists only to be billed.')
param automationMinReplicas int = 0

@description('Maximum replicas for the automation worker. Concurrency is bounded by the Service Bus lock duration, so more than a handful is wasted capacity.')
param automationMaxReplicas int = 3

@description('Portal ingress target port. Must match the EXPOSE in internal-portal/Dockerfile, and the app reads PORT from the environment (see internal-portal/.env.example).')
param portalTargetPort int = 3000

@description('Automation worker container port. Matches PORT in llm-gateway/.env.example.')
param automationTargetPort int = 8787

@description('Ingress transport for the portal. "auto" negotiates HTTP/2.')
param portalIngressTransport string = 'auto'

@description('Portal ingress external. True while APIM and Front Door are the only callers but the app is still internet-reachable; the VNet path in infra/modules/networking is what closes this.')
param portalExternalIngress bool = true

@description('Reject plain HTTP at the portal ingress. The Front Door route force-redirects HTTPS, so this stays satisfiable.')
param portalAllowInsecureIngress bool = false

@description('Whether the automation worker exposes an ingress at all. It consumes the Service Bus queue and answers a health probe; nothing needs to call it. external:false means the only reachable listener is the probe path on the internal environment domain.')
param automationExternalIngress bool = false

@description('Revision suffix. Bumping it forces a new revision, which is how a config-only change reaches a running Container App.')
param revisionSuffix string

@description('URI of the Key Vault holding the runtime secrets, with a trailing slash.')
param keyVaultUri string

@description('Key Vault secret NAMES the portal resolves, by managed identity. Each name IS the environment variable name the application already reads -- see docs/enterprise-target/CONFIG-CONTRACT.md. A name not in that document is a secret that gets provisioned and never read.')
param portalKeyVaultSecretNames array

@description('Key Vault secret NAMES the automation worker resolves, by managed identity. Same contract as above, from the llm-gateway side of the document.')
param automationKeyVaultSecretNames array

@description('Non-secret environment variables for the portal. Exactly the configuration the portal already reads; see docs/enterprise-target/CONFIG-CONTRACT.md.')
param portalEnvironmentVariables array

@description('Non-secret environment variables for the automation worker.')
param automationEnvironmentVariables array

@description('Resource id of the portal managed identity, bound as its runtime identity.')
param portalIdentityId string

@description('Resource id of the automation worker managed identity, bound as its runtime identity.')
param automationIdentityId string

@description('Resource id of the Log Analytics workspace receiving container stdout and system logs.')
param logAnalyticsWorkspaceId string

@description('Fully qualified domain name of the Container Apps environment. The internal hostname the automation worker health probe is served on.')
param containerAppsEnvironmentFqdn string

// WHY THE ENVIRONMENT ID IS A SEPARATE REQUIRED PARAMETER RATHER THAN BUILT HERE:
// a Container Apps environment is either workload-profiles-only (public
// infrastructure) or VNet-integrated (needs a subnet delegated to Microsoft.App
// in infra/modules/networking). Creating it here would mean this module owns the
// subnet decision, and the networking module owns the same decision. Two owners
// of one choice is how a VNet-integration flag ends up half-applied. The
// environment resource therefore lives in infra/modules/networking and its id
// arrives here as a string.
@description('Resource id of the Container Apps managed environment created by infra/modules/networking. Not computable inside this module: a module scope has to be resolvable before the deployment starts.')
param containerAppsEnvironmentId string

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

// WHY json() AND NOT A BARE DECIMAL LITERAL: the Bicep CLI shipped for arm64
// macOS cannot lex decimal literals in some versions -- it parses `0` and then
// treats `.5` as a property access (BCP020/BCP055). The ARM json() expression
// evaluates to the number at deployment time, so the emitted template is correct
// regardless of the local lexer's state.
var portalVcpuJson = json(portalVcpu)
var automationVcpuJson = json(automationVcpu)

// One entry per secret name, so a mismatch between the secret reference and the
// env var that reads it is impossible to express.
var portalSecretDefinitions = map(portalKeyVaultSecretNames, name => {
  name: name
  keyVaultUrl: '${keyVaultUri}secrets/${name}'
  identity: portalIdentityId
})

var portalSecretEnvVars = map(portalKeyVaultSecretNames, name => {
  name: name
  secretRef: name
})

var automationSecretDefinitions = map(automationKeyVaultSecretNames, name => {
  name: name
  keyVaultUrl: '${keyVaultUri}secrets/${name}'
  identity: automationIdentityId
})

var automationSecretEnvVars = map(automationKeyVaultSecretNames, name => {
  name: name
  secretRef: name
})

resource portalApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: portalAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    // The key must be the identity resource id, not a friendly alias, and the
    // value must stay an empty object so the identity is bound but not
    // configured. The identity reference must be computable before the
    // deployment starts, which is why the id is threaded through as a string.
    userAssignedIdentities: {
      '${portalIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    workloadProfileName: workloadProfileName
    configuration: {
      // Single active revision. The portal's durable state moves to PostgreSQL;
      // while DATA_DIR db.json is still the store, two revisions behind one
      // hostname would split session state across them.
      activeRevisionsMode: 'single'
      ingress: {
        external: portalExternalIngress
        targetPort: portalTargetPort
        transport: portalIngressTransport
        allowInsecure: portalAllowInsecureIngress
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      // Secretless: Container Apps resolves each value from Key Vault at
      // start-up using the bound identity. No secret value is ever in the ARM
      // template, in the revision, or in `az containerapp show`.
      secrets: portalSecretDefinitions
    }
    template: {
      containers: [
        {
          // Tag, not digest: creating a revision re-resolves the tag, which is
          // Container Apps' equivalent of a pull policy of Always.
          image: portalImage
          name: portalContainerName
          env: concat(portalEnvironmentVariables, portalSecretEnvVars)
          resources: {
            cpu: portalVcpuJson
            memory: portalMemory
          }
          probes: [
            {
              // /api/health is the route the portal actually serves
              // (internal-portal/src/app.js:175). It is the liveness target
              // because it loads nothing heavy.
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: portalTargetPort
              }
            }
            {
              // /metrics exists on the same app (app.js:194) and is the
              // closest thing the portal has to a dependency-aware readiness
              // signal. Readiness-only: a degraded dependency should stop new
              // traffic, not restart the process.
              type: 'Readiness'
              httpGet: {
                path: '/metrics'
                port: portalTargetPort
              }
            }
          ]
        }
      ]
      revisionSuffix: revisionSuffix
      scale: {
        minReplicas: portalMinReplicas
        maxReplicas: portalMaxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '25'
              }
            }
          }
        ]
      }
    }
  }
}

resource automationApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: automationAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${automationIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    workloadProfileName: workloadProfileName
    configuration: {
      activeRevisionsMode: 'single'
      ingress: {
        // No public listener. The worker is reached over the environment's
        // internal domain and through the Service Bus trigger, not from the
        // internet.
        external: automationExternalIngress
        targetPort: automationTargetPort
        transport: 'http1'
        allowInsecure: true
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      secrets: automationSecretDefinitions
    }
    template: {
      containers: [
        {
          image: automationImage
          name: automationContainerName
          env: concat(automationEnvironmentVariables, automationSecretEnvVars)
          resources: {
            cpu: automationVcpuJson
            memory: automationMemory
          }
          probes: [
            {
              // /health is the gateway's liveness route (llm-gateway/server.py
              // :602). Deliberately the shallow one: the deep route is
              // /health/ready (server.py:612) and belongs in readiness, not in
              // liveness, or an upstream blip restarts every worker.
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: automationTargetPort
              }
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: automationTargetPort
              }
            }
          ]
        }
      ]
      revisionSuffix: revisionSuffix
      scale: {
        // minReplicas 0 with an event-driven scale rule: the worker exists only
        // while there are jobs. A consumer that polls has no reason to be up at
        // 03:00.
        minReplicas: automationMinReplicas
        maxReplicas: automationMaxReplicas
      }
    }
  }
}

// Container stdout and the Container Apps system log categories. Without these
// the only evidence of a start-up failure is a 503 from the ingress.
resource portalDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-portal-containerapp'
  scope: portalApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'ContainerAppConsoleLogs_CL'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs_CL'
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

resource automationDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-automation-containerapp'
  scope: automationApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'ContainerAppConsoleLogs_CL'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs_CL'
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

@description('Ingress FQDN of the portal container app. This is the ServiceUrl of the APIM backend and the origin host of the Front Door route.')
output portalAppFqdn string = portalApp.properties.configuration.ingress.fqdn

@description('Full HTTPS URL of the portal container app.')
output portalAppUrl string = 'https://${portalApp.properties.configuration.ingress.fqdn}'

@description('Resource id of the portal container app.')
output portalAppId string = portalApp.id

@description('Resource id of the automation worker container app.')
output automationAppId string = automationApp.id

@description('Name of the Container Apps environment the apps are placed in, recorded so a runbook names it without reading the network template.')
output containerAppsEnvironmentNameOutput string = containerAppsEnvironmentName

@description('Internal FQDN of the Container Apps environment. The address the automation worker is reachable on from inside the environment.')
output containerAppsEnvironmentDefaultDomain string = containerAppsEnvironmentFqdn