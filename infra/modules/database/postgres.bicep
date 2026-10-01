// Azure Database for PostgreSQL Flexible Server module for Helpdesk durable truth.
// Replaces container-local db.json to guarantee multi-replica safety and ACID transactions.

targetScope = 'resourceGroup'

@description('Deployment region')
param location string

@description('Environment name tag')
param environmentName string

@description('PostgreSQL Server Name')
param serverName string

@description('Administrator login name')
param administratorLogin string = 'helpdeskadmin'

@secure()
@description('Administrator login password')
param administratorLoginPassword string

@description('PostgreSQL major version')
param postgresVersion string = '16'

@description('Compute SKU tier')
param skuName string = 'Standard_B1ms'

@description('Storage size in GB')
param storageSizeGB int = 32

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-03-01-preview' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: 'Burstable'
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// Invariant: SSL connection enforcement (require_secure_transport = ON)
resource requireSslConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-03-01-preview' = {
  parent: postgresServer
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
}

// Primary database for Helpdesk
resource helpdeskDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-03-01-preview' = {
  parent: postgresServer
  name: 'helpdesk'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow Azure Internal Services
resource firewallAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-03-01-preview' = {
  parent: postgresServer
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output serverId string = postgresServer.id
output serverFqdn string = postgresServer.properties.fullyQualifiedDomainName
output databaseName string = helpdeskDb.name
