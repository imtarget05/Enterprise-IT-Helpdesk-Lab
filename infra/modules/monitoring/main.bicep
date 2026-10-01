// Log Analytics workspace + Application Insights for the Helpdesk stack.
//
// WHY THIS IS IN THE BASELINE EVEN THOUGH NOTHING IS DEPLOYED YET: every other
// resource here is unverifiable without it. A portal container app that boots
// and answers 503 has no other evidence trail, and "the deploy looked fine" is
// not a verification. The workspace is the cheapest possible starting point --
// ingestion only, no dashboards or saved searches, which is where the cost
// driver lives.
//
// WHAT THE TELEMETRY IS FOR, SPECIFICALLY:
//   * SLA breaches. observability/slo.yaml and the alerting rules in
//     observability/alertmanager/ define the SLOs; the workspace is where the
//     query side of them runs.
//   * Automation audit. The portal serves GET /api/audit; the Service Bus
//     operational logs here are the other half of that record, covering the
//     consumer side the portal cannot see.
//   * PostgreSQL slow statements, from the server's own logs.

targetScope = 'resourceGroup'

@description('Deployment region. Log Analytics is regional and the region cannot be changed after creation.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Name of the Log Analytics workspace. Must be globally unique.')
param logAnalyticsWorkspaceName string

@description('Name of the Application Insights component.')
param applicationInsightsName string

@description('Owner contact recorded on both resources.')
param ownerContact string

@description('Days of data retained. Ingestion continues past this window and older data becomes inaccessible, which is the cost control that matters. 30 is the platform minimum.')
param logRetentionInDays int = 30

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionInDays
    features: {
      // Audit data is the helpdesk's most sensitive log category. This disables
      // search for a resource that has no workspace-scoped role, so an operator
      // who can read the resource group cannot silently query the audit trail.
      enableDataAccessForPrivateLinkScopedResource: false
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    // Workspace-based: classic Application Insights had a separate data store
    // and separate pricing, so the same telemetry was billed twice. This is the
    // only supported shape going forward.
    WorkspaceResourceId: logAnalytics.id
  }
}

resource workspaceDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-workspace-self'
  scope: logAnalytics
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        category: 'AuditLogs'
        enabled: true
      }
    ]
  }
}

resource insightsDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-insights-self'
  scope: applicationInsights
  properties: {
    workspaceId: logAnalytics.id
  }
}

@description('Resource id of the Log Analytics workspace. Target of every diagnostic setting in this stack.')
output logAnalyticsWorkspaceId string = logAnalytics.id

@description('Name of the Log Analytics workspace, for `az monitor log-analytics workspace show`.')
output logAnalyticsWorkspaceNameOutput string = logAnalytics.name

@description('Resource id of the Application Insights component. Passed to the container apps as the OTLP exporter target.')
output applicationInsightsId string = applicationInsights.id

@description('Connection string of the Application Insights component. This is the OTLP target the portal and gateway exporters are configured with; it is a telemetry sink credential, not an application secret, and it is emitted rather than stored in the vault.')
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString