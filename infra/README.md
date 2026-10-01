# Helpdesk enterprise infrastructure (`infra/`)

**NOT DEPLOYED.** Nothing in this directory has created, updated or deleted an
Azure resource. It is validated — compiled, linted, negative-tested, invariant-
checked and proven independent — by `infra/validate.sh` and by the
`iac-validate` CI job. Neither authenticates to Azure. A green run means the
templates are well-formed and the guards hold; it is not evidence that the stack
exists.

## What this stack is

A public edge in front of a gateway in front of two container apps, with a durable
data tier behind them:

```
browser ──► Front Door (WAF) ──► API Management ──► ca-helpdesk-portal ─┐
                                                            │            ├──► PostgreSQL (durable state)
                              ca-helpdesk-automation ◄── Service Bus queue  ├──► Redis (session + SLA cache)
                                (automation consumer)              │       ├──► Storage (attachments, exports, backups)
                                                                    └──────►  Key Vault (runtime secrets)
```

**There is no vector store, no Qdrant, no embedding service and no RAG component
anywhere in this stack.** The helpdesk automation pipeline is queue-driven and
row-driven. That absence is asserted, not merely intended — see step 7c of
`validate.sh` and cases H1–H3 of `infra/scripts/test_checker_traversal.py`.

## Layout

```text
infra/
├── main.bicep                 # subscription-scoped wiring (params + modules only)
├── main.dev.bicepparam        # dev names/tags; zero-GUID ids; env-sourced password
├── main.prod.bicepparam       # prod names/tags; same contract, no topology switch
├── bicepconfig.json           # core analyzers on (no extension: no Graph resources)
├── validate.sh                # the whole gate; also what CI runs
├── resourceGroups.bicep       # 2 RGs: data (identity/vault/stores) and apps (net/workload/edge)
├── modules/
│   ├── managed-identity/      # 2 UAMIs: portal, automation worker
│   ├── key-vault/             # RBAC only, purge protection, NO secret values
│   ├── postgres/              # durable helpdesk state; TLS enforced by platform
│   ├── redis/                 # session, SLA dedup, job dedup
│   ├── storage/               # attachments, CSV exports, backups
│   ├── service-bus/           # helpdesk-automation-jobs + helpdesk-automation-dlq
│   ├── monitoring/            # Log Analytics + App Insights (workspace-based)
│   ├── networking/            # VNet, 3 subnets, Container Apps environment
│   ├── private-endpoints/     # 5 endpoints, each with its DNS zone group
│   ├── container-app/         # ca-helpdesk-portal + ca-helpdesk-automation
│   ├── apim/                  # gateway: service, api-surface, per-operation policy
│   ├── front-door/            # Premium profile, endpoint, route, WAF
│   └── rbac/                  # least-privilege grants, one invocation per RG
├── apim-policies/             # gateway policy XML, substituted by the apim modules
├── scripts/
│   ├── check_invariants.py    # security invariants, asserted on the COMPILED ARM JSON
│   ├── test_checker_traversal.py # 35 contracts proving the checker actually looks
│   ├── check-independence.sh  # proves no cross-repository dependency (step 8)
│   └── find_external_load_targets.py # helper for the load*Content check
└── validate/
    ├── negative/              # fixtures that MUST fail, with the expected code
    ├── known-weak/            # gaps the type system does NOT catch (must still compile)
    └── negative-secret/       # fixtures the secret scanner MUST catch
```

## Validate

```bash
./infra/validate.sh                       # everything, no Azure access
./infra/scripts/check-independence.sh     # just the independence proof
az bicep build --file infra/main.bicep    # compile only
```

## Required operator actions before any deployment

Nothing below has been done, and nothing can be done from a template:

1. **Replace every placeholder** in the parameter file: `tenantId` and
   `deployIdentityPrincipalId` are the zero GUID and will fail an ARM lookup
   loudly; `keyVaultName`, `postgresServerName`, `redisCacheName`,
   `storageAccountName`, `serviceBusNamespaceName`, `logAnalyticsWorkspaceName`
   and the APIM/Front Door names must be globally unique and are currently
   placeholders. `ownerContact` is `example.invalid` (RFC 2606 — it can never be
   a real mailbox).
2. **Write the secret VALUES out of band.** Only names are committed. The
   PostgreSQL admin password comes from the environment
   (`HELPDESK_POSTGRES_ADMIN_PASSWORD`) in the committed file, or from a Key Vault
   reference on the command line. See `docs/enterprise-target/CONFIG-CONTRACT.md`.
3. **Set `IT_WEBHOOK_URL` in prod**, or accept logged-only alerts deliberately.
   The value in `main.prod.bicepparam` is empty with the reason stated inline.
4. **Get cost approval for Front Door Premium and APIM.** Both carry real monthly
   cost. This tree approves neither.
5. **Resolve the three known gaps** in `CONFIG-CONTRACT.md`, above all: the APIM
   `validate-jwt` policy currently has no token to validate, because the portal
   authenticates locally. That is a decision, not a configuration value.

## Cost

Managed identity and Bicep carry no direct service charge. Key Vault, Log
Analytics and the Standard tiers of PostgreSQL/Redis/Storage/Service Bus are
usage-priced and expected to be low at helpdesk scale. **Front Door Premium, API
Management and Premium ACR-in-a-private-path are not approved for deployment by
this file.** Actual cost has not been measured — nothing has been deployed.

## Rollback

Nothing is deployed, so rollback today is `git revert`. For a future deployment:
keep the prior revision alive until the new one is verified, keep the old
secret/env path until the identity path is proven, and restore traffic rather than
deleting the deployment as a first move. A destroy runbook must list only the
resource groups in the `helpdeskResourceGroupNames` output; anything else it calls
safe to delete is wrong.
