using '../main.bicep'

param location = 'southeastasia'
param environmentName = 'prod'
param tenantId = '00000000-0000-0000-0000-000000000000'
param postgresAdminPassword = 'ProdPlaceholderPassword123!'
param containerImage = 'ghcr.io/imtarget05/enterprise-it-helpdesk-lab:main'
