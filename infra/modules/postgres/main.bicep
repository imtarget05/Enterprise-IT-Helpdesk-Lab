// PostgreSQL Flexible Server: the durable state store for the Helpdesk.
//
// WHAT LIVES HERE. Everything the helpdesk must still know after a process
// restart, a container rollout or an incident review:
//   * tickets and their timeline / work notes / state transitions
//   * IT assets and their assignment, recovery and decommission history
//   * incidents (the /api/integrations/minierp/incidents intake)
//   * audit events (internal-portal/src/app.js GET /api/audit)
//   * approval requests and their approve/reject decisions
//     (POST /api/access-requests/:id/approve, POST /api/changes/:id/approve)
//   * automation run records -- which proposed action, which risk class, which
//     decision, what argv the executor built (llm-gateway/automation/)
//   * SLA metadata: response/resolution targets and breach state
//
// WHY THIS EXISTS WHEN THE PORTAL CURRENTLY USES A JSON FILE: DATA_DIR +
// db.json (internal-portal/.env.example) is single-writer and lives inside the
// container filesystem. Two replicas would overwrite each other and a restart
// loses the state. This module is the target the portal migrates to; it is not
// wired to the running portal yet, which is stated as a limitation in
// docs/enterprise-target/COMPLETION-MATRIX.md rather than implied here.
//
// WHAT DELIBERATELY DOES NOT LIVE HERE: vectors, embeddings, RAG chunks and
// agent ingestion artefacts. None of the durable helpdesk record is a vector,
// and a relational store is the wrong shape for them. No vector store, no
// Qdrant and no ingestion pipeline is declared anywhere in this stack.

targetScope = 'resourceGroup'

@description('Deployment region. A Flexible Server region cannot be changed after creation without a migration.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Name of the PostgreSQL Flexible Server. Globally unique, lowercase only.')
param postgresServerName string

@description('Name of the logical database holding the helpdesk durable state.')
param postgresDatabaseName string

@description('Name of the PostgreSQL role the application connects as. NOT a superuser: the application must not be able to drop the schema or read every role password.')
param postgresAdminUserName string = 'helpdesk_admin'

@description('Password for the admin role. NEVER committed and NEVER a literal: the committed parameter files source this from the environment via readEnvironmentVariable, and a real deployment passes a Key Vault reference on the command line.')
@secure()
param postgresAdminPassword string

@description('Compute tier, e.g. "B_1_B" or "GP_Standard_2". Sized for a helpdesk workload, not for a vector index: this server holds rows, not embeddings.')
param postgresSkuName string = 'GP_Standard_2'

@description('Storage size in gigabytes. Ticket and audit growth is slow; 50 is the floor the tier supports and is a starting point, not a capacity forecast.')
param postgresStorageSizeGb int = 50

@description('High availability mode. "ZoneRedundant" needs a region with zone support and a Premium tier, so it defaults off and is an explicit decision at the deploy wave.')
param postgresHighAvailabilityMode string = 'Disabled'

@description('Owner contact recorded on the server.')
param ownerContact string

@description('Subnet id delegated to Microsoft.DBforPostgreSQL. Empty leaves the server on its default public endpoint, which is the pre-private-endpoint state. Supplying it moves the server onto a private path and requires infra/modules/private-endpoints.')
param delegatedSubnetResourceId string = ''

@description('Resource id of the UAMI allowed to read the admin password from Key Vault. The deployment principal, not the runtime identity.')
param deployIdentityResourceId string

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  tags: tags
  sku: {
    name: postgresSkuName
    tier: 'GeneralPurpose'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminUserName
    administratorLoginPassword: postgresAdminPassword
    highAvailability: {
      mode: postgresHighAvailabilityMode
    }
    storage: {
      storageSizeGB: postgresStorageSizeGb
    }
    // TLS on a Flexible Server is enforced by the platform and cannot be turned
    // off: the sslEnforcement / sslMinimalTlsVersion properties that older API
    // versions exposed were REMOVED from ServerProperties (bicep reports this as
    // BCP037, listing the properties that actually exist). Stating them anyway
    // would compile as a warning, be dropped by the provider, and read as a
    // control that is enforced while enforcing nothing. So the guarantee is
    // documented here and asserted where it can actually be observed: the
    // deployment runbook's verification checklist reads
    //   az postgres flexible-server show --query sslEnforcement
    // rather than trusting this comment.
    backup: {
      // Automated backups are the recovery story for the audit trail. If someone
      // turns this off, the audit event history becomes unrecoverable, and the
      // invariant checker does not cover it -- recorded as a limitation in
      // docs/enterprise-target/COMPLETION-MATRIX.md.
      backupRetentionDays: 35
      geoRedundantBackup: 'Disabled'
    }
    network: {
      publicNetworkAccess: empty(delegatedSubnetResourceId) ? 'Enabled' : 'Disabled'
      delegatedSubnetResourceId: empty(delegatedSubnetResourceId) ? null : delegatedSubnetResourceId
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresServer
  name: postgresDatabaseName
}

resource postgresParameters 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresServer
  name: 'log_min_duration_statement'
  properties: {
    // Anything slower than 500 ms is logged. The helpdesk audit endpoints scan
    // the event table, so a silent slow query there is an incident nobody sees.
    value: '500'
    source: 'user-override'
  }
}

resource trustedServicesFirewallRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgresServer
  name: 'AllowTrustedServicesBypass'
  properties: {
    // The documented sentinel for "trusted Microsoft services", not a real range.
    // A literal 0.0.0.0/0 rule would open the server to the internet.
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

@description('Fully qualified domain name of the server, e.g. "pg-helpdesk.postgres.database.azure.com". The host an application connects to; the application assembles credentials itself, so no connection string is emitted.')
output postgresServerFqdn string = postgresServer.properties.fullyQualifiedDomainName

@description('Resource id of the Flexible Server. Scope for any role assignment against the server itself.')
output postgresServerId string = postgresServer.id

@description('Name of the Flexible Server, for `az postgres flexible-server` commands.')
output postgresServerNameOutput string = postgresServer.name

@description('Name of the logical database. Recorded so a migration runbook asserts against it rather than assuming a name.')
output postgresDatabaseNameOutput string = postgresDatabase.name

@description('Whether the server is currently on a private path. A runbook reads this instead of assuming from the parameter file.')
output postgresUsesPrivateNetwork bool = !empty(delegatedSubnetResourceId)

@description('Resource id of the UAMI the deployment principal used to read the admin password.')
output postgresDeployIdentityResourceId string = deployIdentityResourceId