# =============================================================================
#  dev environment variables — parity with ../parameters/dev.bicepparam
#
#  Placeholder-only. It exists so the shape of the configuration (including the
#  plan-time leak control) can be exercised with no real credential. A real
#  password is supplied out of band and ALWAYS overrides this value:
#      export TF_VAR_postgres_admin_password='...'   (never committed)
#  or referenced from Key Vault by the calling pipeline (Phase 2 OIDC).
# =============================================================================

location         = "southeastasia"
environment_name = "dev"
tenant_id        = "00000000-0000-0000-0000-000000000000"
name_suffix      = "helpdesk-dev"
container_image  = "ghcr.io/imtarget05/enterprise-it-helpdesk-lab-it-portal:dev"

postgres_admin_password = "Dev-PLACEHOLDER-NOT-A-REAL-PASSWORD-0000"
