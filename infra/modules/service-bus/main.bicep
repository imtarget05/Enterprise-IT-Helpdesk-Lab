// Service Bus namespace: the helpdesk automation pipeline.
//
// WHAT THIS IS. The queue that carries automation work between the thing that
// decides and the thing that acts. Today both roles live in one process
// (llm-gateway/automation/gateway.py proposes, llm-gateway/automation/executor.py
// runs the PowerShell). Splitting the executor onto its own identity with its
// own queue is what makes the proposal/decision boundary enforceable: the
// consumer that runs scripts has no LLM upstream, and the process that talks to
// the LLM has no filesystem write path.
//
// THE QUEUE NAMES ARE PART OF THE CONTRACT, not decoration:
//   helpdesk-automation-jobs   approved and policy-cleared automation proposals
//   helpdesk-automation-dlq     anything that exceeded maxDeliveryCount or that
//                              the poison filter moved aside
//
// WHY THE DEAD-LETTER QUEUE IS A FIRST-CLASS RESOURCE HERE RATHER THAN A
// PROPERTY: llm-gateway/automation/policy.py marks new_company_user,
// disable_company_user and restore_helpdesk_data as HIGH_RISK, which
// requires_approval() gates. An approved action that then fails to execute must
// be visible to a human. A message that vanishes on its fifth delivery failure
// is an automation run that nobody reviewed, on exactly the highest-risk
// actions in the system.
//
// WHAT DOES NOT BELONG HERE: model prompts, completions or anything RAG-shaped.
// The gateway is an HTTP service; Service Bus carries job descriptors.

targetScope = 'resourceGroup'

@description('Deployment region. Service Bus namespaces auto-replicate within the paired region.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Name of the Service Bus namespace. Globally unique, 6-50 characters.')
param serviceBusNamespaceName string

@description('Owner contact recorded on the namespace, queues and topic.')
param ownerContact string

@description('SKU. Standard carries the features this pipeline needs. Premium is only justified when the queue must survive a zone loss, which is an explicit later decision.')
param serviceBusSku string = 'Standard'

@description('Name of the automation job queue. The default value matches the name in the module header and in docs/enterprise-target/CONFIG-CONTRACT.md; a parameter file may override it, and a runbook reads the output below rather than assuming.')
param automationQueueName string = 'helpdesk-automation-jobs'

@description('Name of the dead-letter queue for the automation queue.')
param automationDeadLetterQueueName string = 'helpdesk-automation-dlq'

@description('Name of the audit topic the consumer publishes automation outcomes to. Subscribers are the portal audit trail and the alerting pipeline.')
param automationOutcomeTopicName string = 'helpdesk-automation-outcomes'

@description('Default message time-to-live in seconds. Short on purpose: an automation proposal is stale once its approval window closes, and a live queue of expired approvals is an approval nobody re-checked.')
param automationMessageTimeToLiveSeconds int = 86400

@description('Maximum delivery attempts before a message is dead-lettered. Five is enough to ride out a consumer restart and short enough that a genuinely broken action is not retried all day.')
param automationMaxDeliveryCount int = 5

@description('True when the namespace is reachable only through a private endpoint. Leave false until infra/modules/private-endpoints exists, because a Deny default with no endpoint dead-letters the pipeline silently.')
param enablePrivateNetwork bool = false

@description('Resource id of the Log Analytics workspace receiving Service Bus operational and VNet audit logs.')
param logAnalyticsWorkspaceId string

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

// WHY THE TTL IS COMPUTED HERE AND NOT WRITTEN AS A LITERAL: Service Bus takes an
// ISO 8601 duration while the parameter above is a number of seconds an operator
// can reason about. `PT86400S` is a valid ISO 8601 duration and is what the
// service parses, so the translation is a string interpolation rather than
// hand-written duration syntax that someone would have to learn to edit.
var automationMessageTimeToLiveIso = 'PT${automationMessageTimeToLiveSeconds}S'

resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: serviceBusNamespaceName
  location: location
  tags: tags
  sku: {
    name: serviceBusSku
    tier: 'Standard'
  }
  properties: {
    publicNetworkAccess: enablePrivateNetwork ? 'Disabled' : 'Enabled'
    minimumTlsVersion: '1.2'
    // Queue-based auth. The consumer authenticates with the managed identity in
    // infra/modules/rbac, never with a shared connection string.
    disableLocalAuth: true
    zoneRedundant: false
  }
}

resource automationQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: serviceBusNamespace
  name: automationQueueName
  properties: {
    // A bounded queue with an explicit TTL: the automation pipeline is a work
    // queue, not a log. Anything that cannot be acted on within a day should be
    // dead-lettered and looked at, not retried indefinitely.
    lockDuration: 'PT1M'
    defaultMessageTimeToLive: automationMessageTimeToLiveIso
    maxDeliveryCount: automationMaxDeliveryCount
    deadLetteringOnMessageExpiration: true
    requiresDuplicateDetection: false
    // Sessions are explicitly OFF. The automation pipeline delivers independent
    // job descriptors, and session ordering would make one stuck job block every
    // later one on the same session. The property is requiresSession:false, not
    // supportsSession -- the latter was removed from the ARM type and is silently
    // dropped if written.
    requiresSession: false
  }
}

resource automationDeadLetterQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: serviceBusNamespace
  name: automationDeadLetterQueueName
  properties: {
    lockDuration: 'PT5M'
    maxDeliveryCount: automationMaxDeliveryCount
  }
}

resource automationOutcomeTopic 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' = {
  parent: serviceBusNamespace
  name: automationOutcomeTopicName
  properties: {
    // Duplicate detection on the outcome topic is on because the consumer
    // publishes at-least-once: a crash between "executed" and "acknowledged"
    // republishes the outcome, and a duplicated audit event is a wrong record.
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    defaultMessageTimeToLive: automationMessageTimeToLiveIso
  }
}

resource automationOutcomeSubscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2022-10-01-preview' = {
  parent: automationOutcomeTopic
  name: 'audit-trail'
  properties: {
    defaultMessageTimeToLive: automationMessageTimeToLiveIso
    maxDeliveryCount: automationMaxDeliveryCount
    deadLetteringOnMessageExpiration: true
  }
}

resource serviceBusDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-servicebus'
  scope: serviceBusNamespace
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'OperationalLogs'
        enabled: true
      }
      {
        // VNet and IP filter logs. Without these, "why did the message not
        // arrive" has no answer once the namespace is private.
        category: 'VNetConnectionAuditLogs'
        enabled: true
      }
      {
        category: 'IPAuditLogs'
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

@description('Fully qualified domain name of the namespace, e.g. "sb-helpdesk.servicebus.windows.net".')
output serviceBusEndpoint string = serviceBusNamespace.properties.serviceBusEndpoint

@description('Resource id of the namespace. Scope for the Azure Service Bus Data Receiver/Sender grants in infra/modules/rbac.')
output serviceBusNamespaceId string = serviceBusNamespace.id

@description('Name of the namespace, for `az servicebus` commands.')
output serviceBusNamespaceNameOutput string = serviceBusNamespace.name

@description('Name of the automation job queue. A deployment runbook and the application config both read this rather than hardcoding it.')
output automationQueueNameOutput string = automationQueue.name

@description('Name of the dead-letter queue. A monitoring alert targets this; an empty DLQ is a healthy pipeline, a non-empty one is a ticket.')
output automationDeadLetterQueueNameOutput string = automationDeadLetterQueue.name

@description('Name of the automation outcome topic.')
output automationOutcomeTopicNameOutput string = automationOutcomeTopic.name

@description('Whether the namespace is currently on a private path.')
output serviceBusUsesPrivateNetwork bool = enablePrivateNetwork