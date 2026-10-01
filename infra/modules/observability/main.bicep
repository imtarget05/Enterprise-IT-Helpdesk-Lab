// Observability module for Enterprise IT Helpdesk Lab.
// Provisions Log Analytics Workspace and Application Insights component.

targetScope = 'resourceGroup'

@description('Deployment region')
param location string

@description('Environment name tag')
param environmentName string

@description('Log Analytics Workspace Name')
param workspaceName string

@description('Application Insights Component Name')
param appInsightsName string

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output appInsightsId string = appInsights.id
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsInstrumentationKey string = appInsights.properties.InstrumentationKey
