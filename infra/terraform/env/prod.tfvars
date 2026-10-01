# =============================================================================
#  prod environment variables — parity with ../parameters/prod.bicepparam
#
#  Placeholder-only. Supply the real password out of band
#  (TF_VAR_postgres_admin_password or a Key Vault reference from the pipeline).
#  Never commit a real value: the plan-invariant control scans plan JSON for it.
# =============================================================================

location         = "southeastasia"
environment_name = "prod"
tenant_id        = "00000000-0000-0000-0000-000000000000"
name_suffix      = "helpdesk-prod"
container_image  = "ghcr.io/imtarget05/enterprise-it-helpdesk-lab-it-portal:main"

postgres_admin_password = "Prod-PLACEHOLDER-NOT-A-REAL-PASSWORD-0000"
