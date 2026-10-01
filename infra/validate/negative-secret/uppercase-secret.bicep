// NEGATIVE FIXTURE — NOT DEPLOYED, NOT COMPILED.
//
// This file is test data for step 5b of infra/validate.sh. It lives under
// validate/, which the compile step skips and the main secret scan excludes,
// precisely so a file containing real-looking secrets can exist in the repository
// without turning the suite permanently red.
//
// WHY THIS EXISTS. A secret detector written with `grep -rnE` is
// case-SENSITIVE. It matches `password = 'x'` and misses
// `MINIERP_INTEGRATION_KEY = 'x'` -- but uppercase is the convention this
// repository uses for every secret-bearing variable: OPENAI_API_KEY,
// MINIERP_INTEGRATION_KEY, LLM_CLOUD_API_KEY. A detector that is green while blind
// to the exact shape of secret this project commits is worse than no detector,
// because it reads as coverage.
//
// Step 5b re-runs the SAME detector over this directory and REQUIRES it to fire.
// If someone reintroduces case sensitivity, that step fails.
//
// Every value below is deliberately fake, is not a credential to anything, and is
// never read by the application or by any deployment.

param openaiApiKey = 'sk-not-a-real-key-THIS_IS_A_TEST_FIXTURE_0000000000'
param MINIERP_INTEGRATION_KEY = 'minierp-key-not-a-real-credential'
param LLM_CLOUD_API_KEY = 'cloud-llm-key-not-a-real-credential'
param LAB_AUTH_USERS = '{"admin":{"password":"change-me-not-a-real-credential","role":"IT_ADMIN"}}'
param clientSecret = 'sso-client-secret-not-a-real-credential'
param postgresAdminPassword = 'pg-admin-password-not-a-real-credential'
