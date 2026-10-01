// Service Bus Standard messaging module for Helpdesk asynchronous jobs.
// Provides queue-driven automation, dead-lettering, and message deduplication.

targetScope = 'resourceGroup'

@description('Deployment region')
param location string

@description('Environment name tag')
param environmentName string

@description('Service Bus Namespace Name')
param namespaceName string

@description('Automation Queue Name')
param queueName string = 'helpdesk-automation-jobs'

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
}

resource sbNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: namespaceName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

resource automationQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sbNamespace
  name: queueName
  properties: {
    lockDuration: 'PT5M'
    maxDeliveryCount: 10
    deadLetteringOnMessageExpiration: true
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    enableBatchedOperations: true
  }
}

output namespaceId string = sbNamespace.id
output namespaceName string = sbNamespace.name
output queueName string = automationQueue.name
