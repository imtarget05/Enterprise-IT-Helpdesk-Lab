// Storage account: helpdesk attachments, exports and backups.
//
// WHAT LIVES HERE:
//   * ticket attachments and evidence screenshots (the portal's current file
//     store is DATA_DIR under the container filesystem, internal-portal/
//     .env.example)
//   * generated exports: GET /api/assets/export.csv and
//     GET /api/tickets/export.csv
//   * backup blobs written by scripts/Backup-HelpdeskData.ps1
//   * the bootstrap artifact the automation worker's backup/restore actions
//     read and write (llm-gateway/automation/executor.py maps
//     backup_helpdesk_data / restore_helpdesk_data onto those scripts)
//
// WHAT DOES NOT LIVE HERE: nothing vector, nothing embedding-related. The
// runbook knowledge corpus the portal can optionally index lives in the
// application tier as files; this account is durable state and exports, nothing
// more.

targetScope = 'resourceGroup'

@description('Deployment region.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Name of the storage account. Globally unique, 3-24 lowercase alphanumeric characters, no hyphens.')
param storageAccountName string

@description('Owner contact recorded on the account and containers.')
param ownerContact string

@description('Minimum TLS version accepted by the account endpoint. 1.2 is the platform baseline and is asserted by infra/scripts/check_invariants.py.')
param storageMinimumTlsVersion string = 'TLS1_2'

@description('True when the account is reachable only through a private endpoint. A Deny default with no private endpoint would block the container apps from their own data, so this only flips when infra/modules/private-endpoints creates the endpoints.')
param enablePrivateNetwork bool = false

@description('Names of blob containers to create. Kept as a parameter so a reviewer can see the storage surface in the parameter file rather than inferring it from the template.')
param containerNames array

@description('Resource id of the Log Analytics workspace receiving blob read/write/delete diagnostics. A storage account whose deletes are not logged has no record of who removed a ticket attachment.')
param logAnalyticsWorkspaceId string

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    // Blob public access off. An account that allows a container to serve
    // anonymous GET means a ticket screenshot is one guessed URL from being
    // world-readable.
    allowBlobPublicAccess: false
    // HTTPS-only, required, and stated as the minimum version rather than
    // trusting the account default.
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: storageMinimumTlsVersion
    publicNetworkAccess: enablePrivateNetwork ? 'Disabled' : 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: enablePrivateNetwork ? 'Deny' : 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
    // ADLS Gen2 on a StorageV2 account is free, but hierarchical namespace is
    // NOT compatible with a private endpoint created against blob alone in
    // every path, so it is left off and the bucket layout stays flat.
    isHnsEnabled: false
  }
}

// WHY THE blobService IS DECLARED AS A RESOURCE RATHER THAN SKIPPED TO:
// a container's parent is the blobServices child resource, and Bicep `parent:` can
// only bind to a resource this template declares. Skipping straight to the
// container with the account as parent is a BCP036 compile error, not a style
// preference.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    // Soft delete on the blob service is what makes an accidental delete
    // recoverable. Container soft delete is separate and is configured by the
    // platform for new accounts.
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource blobContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for containerName in containerNames: {
    parent: blobService
    name: containerName
    properties: {
      // No public access at the container level either. The account already
      // forbids it; repeating it here means a container created later through
      // the portal inherits the same posture.
      publicAccess: 'None'
    }
  }
]

resource blobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-storage-blob'
  scope: storageAccount
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'StorageRead'
        enabled: true
      }
      {
        category: 'StorageWrite'
        enabled: true
      }
      {
        category: 'StorageDelete'
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

@description('Blob service endpoint. The application forms URLs from this; no account key is ever emitted.')
output storageBlobEndpoint string = storageAccount.properties.primaryEndpoints.blob

@description('Resource id of the storage account. Scope for the Storage Blob Data Contributor grant in infra/modules/rbac.')
output storageAccountId string = storageAccount.id

@description('Name of the storage account, for `az storage` commands.')
output storageAccountNameOutput string = storageAccount.name

@description('Names of the blob containers created. A runbook can assert the list rather than assume it.')
output blobContainerNames array = containerNames

@description('Whether the account is currently on a private path.')
output storageUsesPrivateNetwork bool = enablePrivateNetwork