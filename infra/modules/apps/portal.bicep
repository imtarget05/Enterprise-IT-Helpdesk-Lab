// Azure Container Apps module for Enterprise IT Helpdesk Portal.
// Deploys the Node.js Express internal portal with health probes and scaling rules.

targetScope = 'resourceGroup'

@description('Deployment region')
param location string

@description('Environment name tag')
param environmentName string

@description('Container App Environment Name')
param managedEnvironmentName string

@description('Container App Name')
param containerAppName string

@description('Container Image')
param containerImage string

@description('Optional delegated subnet ID for ACA VNet injection')
param infrastructureSubnetId string = ''

@description('Key Vault URI for secret references')
param keyVaultUri string = ''

@description('Application Insights Connection String')
@secure()
param appInsightsConnectionString string = ''

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
}

resource managedEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: managedEnvironmentName
  location: location
  tags: tags
  properties: {
    vnetConfiguration: empty(infrastructureSubnetId) ? null : {
      infrastructureSubnetId: infrastructureSubnetId
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'helpdesk-portal'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'KEY_VAULT_URI'
              value: keyVaultUri
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsightsConnectionString
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 15
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

output appFqdn string = containerApp.properties.configuration.ingress.fqdn
output appId string = containerApp.id
output appPrincipalId string = containerApp.identity.principalId
