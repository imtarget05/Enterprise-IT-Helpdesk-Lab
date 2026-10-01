# Infra origin — what was copied from where, and why nothing is shared

**Purpose.** This repository's `infra/` tree was bootstrapped from the
infrastructure tree of a sibling repository. This document records exactly what
came from where, so that a future contributor can see the boundary without
re-deriving it — and so that "let's deduplicate these two IaC trees back into one
shared module" can be recognised for what it is and declined.

## Source

| | |
|---|---|
| Source repository | `MAIA` (read-only snapshot at `/private/tmp/ent-maia`, never written to) |
| Source commit SHA | `8faabf028b7b1eacaefd917d40a77e1cbff13fe9` |
| Source tree object (`infra/`) | `63da0f8c61033993fef413d6366c7757ce760beb` |
| Source commit subject | `fix(infra): fail closed on malformed ARM shapes, with traversal controls (#10)` |
| Destination repository | `Enterprise-IT-Helpdesk-Lab`, branch `ent/enterprise-target` |
| Destination baseline SHA | `6f23c1253fadf41835e9f7dcf58f81f553c279a3` |
| Direction | One-way. The copy is now owned by Helpdesk forever. |

## Intent

> **Shared concepts are copied as bootstrap templates, not imported as shared
> runtime/deployment dependencies.**

The rationale, stated so it survives the next refactoring attempt:

**Independent lifecycle beats DRY coupling.** A shared Bicep module would couple
two products with different release cadences, different blast radii and different
regulatory owners. When the Helpdesk stack needs a Key Vault module that the MAIA
stack must not have — a different purge-retention policy, a different private-path
posture, a different set of grants — the shared module becomes a fork with an
upstream, and every Helpdesk security change is now a change to MAIA's deployment
template. The two stacks would share a git URL instead of sharing a decision.

The duplicated text here is small, bounded and commented. The coupling it would
save is the ability to deploy one without breaking the other, which is worth more
than the lines.

This is not a claim that duplication is free. It is a claim that this particular
duplication is the cheaper side of the trade, and the check that enforces it is
`infra/scripts/check-independence.sh`, wired into `infra/validate.sh` step 8 and
therefore into CI.

## Per-file classification

Every file in the source `infra/` tree, classified as **A** (generic reusable
pattern — copied, possibly with edits), **B** (source-specific — rewritten for
Helpdesk) or **C** (not safe to copy).

### A — generic pattern, copied

| Source file | Destination | Action | What was kept / changed |
|---|---|---|---|
| `bicepconfig.json` | `infra/bicepconfig.json` | copied | **Reduced.** Core analyzers kept and enabled. The `microsoftGraphV1` extension and `extensibility` were **removed** because no module in this stack declares a tenant-scoped Graph resource — `modules/managed-identity` creates no Entra app registration (see B below). A pinned extension with no consumer is an unpinned supply-chain surface for no benefit. |
| `resourceGroups.bicep` | `infra/resourceGroups.bicep` | rewritten | Pattern kept (subscription scope, one shared `var tags`, resource ids as outputs). **3 RGs → 2**: `data` (identity, vault, durable stores) and `apps` (network, container apps, monitoring, edge). The third source RG existed to separate two edge tiers that this stack does not have; two groups here is the boundary that actually buys something — an operator with write access to the app tier has no write access to the durable helpdesk record. |
| `validate.sh` (structure) | `infra/validate.sh` | rewritten | Structure kept: compile-everything → params → negative → known-weak → secrets → invariants → traversal. Seven defects fixed against the source version, each measured on this machine rather than assumed: (a) `fail()` read its detail from stdin, so a FAIL printed no findings and the script exited 0; (b) the bicep CLI probe did not account for `az bicep` argument differences, so all 17 compiles failed on a machine with only the Azure CLI; (c) `trap "rm -rf '$invariant_dir'"` expanded the variable at trap-registration time on some shells; (d) the secret regex was case-sensitive and blind to this repo's own `*_KEY` convention; (e) the checker-traversal step ran twice; (f) `bcrypt`-style idempotence aside, `find params parameters` assumed both directories existed; (g) no check for a non-placeholder `containerImage`. |
| `check_invariants.py` (concept) | `infra/scripts/check_invariants.py` | rewritten | The core idea kept verbatim in spirit: **assert on the compiled ARM JSON, not the .bicep source**, because a source grep passes on a comment or a resource that is never deployed. Changed: the invariant table is now keyed by *resource type + property* (source version keyed by property name only, so it asserted `enablePurgeProtection` on anything that had one); the type matcher is now **exact** for property invariants and **prefix** for absence checks (a prefix match made `Microsoft.ServiceBus/namespaces` also match every queue and topic on the namespace, so `disableLocalAuth` was asserted on queues that correctly do not carry it); a PostgreSQL firewall-range check was added; and a whole new **absence** assertion was added — see below. |
| `scripts/test_checker_traversal.py` (concept) | `infra/scripts/test_checker_traversal.py` | rewritten | Kept: list/map/nested-map/nested-list traversal, malformed-shape fail-closed, absent-property-bites. Extended from 20 to **35** contracts: one per invariant (the source suite only proved two vault properties bite), PostgreSQL firewall cases, absence-assertion cases, and **case I1** — "the absence checks are emitted, not silently skipped" — which is the guard against a walk that stopped reading and passed vacuously. |
| `validate/negative/*` (pattern) | `infra/validate/negative/{missing-deploy-identity,principal-id-wrong-type}.bicepparam` | rewritten | Two fixtures kept, same intent: a required security parameter cannot be omitted (`BCP258`) and a principal id cannot be a non-string (`BCP033`). Both rewritten against Helpdesk's parameter set. |
| `validate/known-weak/*` (pattern) | `infra/validate/known-weak/keyvault-name-constraint-provider-enforced.bicepparam` | rewritten | Kept, and made *sharper*: the source fixture used a legal-looking name. This one uses `THIS_IS_NOT_A_LEGAL_KEY_VAULT_NAME_AT_ALL` (underscores, over 24 chars) so the file compiling is unambiguous proof that the constraint is still provider-enforced only. |
| `validate/negative-secret/*` (pattern) | `infra/validate/negative-secret/uppercase-secret.bicep` | rewritten | Kept: the scanner's negative control. Values changed to this repo's own secret names (`MINIERP_INTEGRATION_KEY`, `LLM_CLOUD_API_KEY`, `OPENAI_API_KEY`, `LAB_AUTH_USERS`, `postgresAdminPassword`), which is exactly the shape the case-sensitive version of the regex missed. |
| `.github/workflows/iac-validate.yml` (structure) | `.github/workflows/iac-validate.yml` | rewritten | Structure kept: separate workflow from the app CI, triggers on `infra/**`, `permissions: contents: read`, no `environment:`, install-then-validate, upload the compiled template as the reviewable artifact. Independent: every path is repository-relative, no reusable workflow, no `needs:` across workflows. |

### B — source-specific, rewritten

| Source file | Disposition | Why it could not be copied |
|---|---|---|
| `modules/identity/main.bicep` | **Rewritten** as `infra/modules/managed-identity/main.bicep`, Entra registration **deleted** | The source module creates an Entra application registration, service principal and `requestedResourceAccess` for APIM's `validate-jwt`. Nothing in Helpdesk consumes an Entra-issued token: the portal authenticates locally (`src/auth.js`, `AUTH_MODE=lab`) and the automation surface is guarded by role checks in `llm-gateway/automation/policy.py`. A registration would be a credential guarding nothing. **The gap this creates is recorded, not hidden** — see "Known gap 3" in `CONFIG-CONTRACT.md`: the gateway's `validate-jwt` policy currently has no token to validate. |
| `modules/apps/main.bicep` | **Rewritten** as `infra/modules/container-app/main.bicep` | One module became two apps with two identities. Image `maia-api` → the portal image; a second app for the llm-gateway/automation worker. Container name `maia-api` → `helpdesk-portal`. Health probes `/health`+`/ready` → the routes this application actually serves (`/api/health`, `/metrics` for the portal at `src/app.js:175,194`; `/health`+`/health/ready` for the gateway at `server.py:602,612`). Memory comment about the retrieval stack OOM → removed; there is no retrieval stack in this stack. Secret-name contract re-pointed at this repo's env names. The ACR block was **dropped entirely**: this repo's images come from its own registry (`.github/workflows/build-container.yml`) and nothing pushes to ACR. The second reserved workload profile was kept. |
| `modules/keyvault/main.bicep` | **Rewritten** as `infra/modules/key-vault/main.bicep` | Security properties kept **verbatim** because they are genuinely universal (`enablePurgeProtection: true`, `enableRbacAuthorization: true`, purge protection asserted rather than defaulted). Tag `project: 'maia'` → `'helpdesk'`. The secret-name contract comment now points at `CONFIG-CONTRACT.md` and at this repo's own reads. |
| `modules/rbac/main.bicep` | **Rewritten** as `infra/modules/rbac/main.bicep` | Grant set completely different, because the workloads are different. Source grants: Key Vault Secrets User, AcrPull, Storage Blob Data Contributor, deploy Contributor. Helpdesk grants: Key Vault Secrets User + Crypto User (portal signs its own tokens), Storage Blob Data Contributor, **Service Bus Data Sender** (portal publishes proposals), **Service Bus Data Receiver + Sender** (automation worker), PostgreSQL Contributor, Redis Contributor, deploy Contributor. Two source grants were dropped rather than translated: `acrPull` (no ACR) and the blob grant moved under a different principal. One non-obvious decision is written into the file: the automation worker gets **no** PostgreSQL or storage role, because `executor.py` runs PowerShell and an identity that runs queued code should not be able to rewrite the record of what it ran. |
| `modules/observability/main.bicep` | **Rewritten** as `infra/modules/monitoring/main.bicep` | `enableLogAccessUsingOnlyResourcePermissions` was **removed** — it is not a property on `WorkspaceProperties` in the current type definition, so the source version compiled with a BCP037 warning and the provider silently dropped it. Reading it as a working control would be reading a no-op as a control. `features.enableDataAccessForPrivateLinkScopedResource: false` is kept, which is the property that actually exists. Instrumentation key output → connection string, since ACA's OTLP exporter consumes the connection string. |
| `modules/apim/*.bicep` (4 files) | **Rewritten** as `infra/modules/apim/{api-service,api-surface,operation}.bicep` | The module split (service / api-surface / operation) is genuinely load-bearing and kept: Bicep forbids a nested resource inside a for-expression, so per-operation policies need one module per operation. Changed: publisher name `MAIA Platform` → `Helpdesk Platform`; the API description now describes tickets/assets/incidents/approvals; the operation list moved entirely into the parameter file so it is reviewable data rather than template. |
| `apim-policies/api-inbound.xml` | **Rewritten** | Comments rewrote to the helpdesk path. The CORS/rate-limit structure is unchanged because it is the correct structure. |
| `apim-policies/operation-protected.xml` | **Rewritten** | Substituted tokens changed. Critically: the source comment explained that it re-validated the app's own JWT at the edge. That reasoning does **not** transfer, because Helpdesk's portal does not mint Entra tokens. The file is kept as the correct shape for when it does, and the mismatch is documented as a known gap rather than papered over with a comment claiming a guarantee that does not exist. |
| `apim-policies/operation-public.xml` | **Rewritten** | Route names `/api/health` + `/metrics`, matching this application. |
| `modules/edge/main.bicep` | **Rewritten** as `infra/modules/front-door/main.bicep` | Kept: Premium SKU reasoning, WAF managed rules, the `concat`-not-spread workaround for the union type, the absence of a HighAlert action and the per-bot-category severity expression. Changed: origin is the **APIM gateway host**, not the container app, because that is where `validate-jwt` and the per-key rate limits live. The `sharedPrivateLinkResource` block was **removed** with the reason written inline: a Consumption APIM cannot be reached over a private endpoint, so a private-link origin would create a connection that can never be approved. |
| `parameters/{dev,prod}.bicepparam` | **Rewritten** as `main.{dev,prod}.bicepparam` | Names `*-maia-*` → `*-helpdesk-*`. The `containerImage` `ghcr.io/imtarget05/maia-maia-api:<sha>` was replaced (see C). `apiOperations` is now a real allowlist of this app's routes rather than an empty array. The `entraApplicationName` / `webRedirectUris` / `spaRedirectUris` parameters are gone with the registration. |
| `modules/edge` WAF rule-set version comment | Rewritten | The source's dated note about DRS 1.0 vs the Front Door rule-set support policy was re-derived rather than copied, and the upgrade is recorded as an open item. |

### C — not copied

| Source file | Why it is not safe to copy |
|---|---|
| `main.bicep` (top-level wiring) | MAIA-specific: it wires `maia-identity` / `maia-keyvault` / `maia-rbac-identity`, deploys **only** the identity half of its own stack, and its outputs are named `maia*`. Copied as a **shape** — subscription scope, parameters-only, modules for resources, `dependsOn` ordering with the reasoning inline — and rewritten around Helpdesk's twelve modules. The source's "deploys nothing" comment is preserved and extended with the specific claim that `helpdeskDeployed` is emitted as `false`. |
| `main.v6-target.bicep` | **Not copied in any form.** It is a design record for an architecture its own repository never built: it wires APIM + Front Door + edge + apps together with a parameter file whose image reference is real and whose `apiOperations` array is empty. Carrying an unbuilt end-state file into a second repository would import a design nobody has validated as a template nobody has reviewed. Helpdesk's equivalent is `main.bicep`, which wires what Helpdesk actually specifies. |
| `scripts/validate-v1-scope.py` | Not copied as-is. It hardcodes `infra/parameters/v1-{dev,prod}.bicepparam` (paths that do not exist here) and an allowlist/forbidden-list specific to MAIA's V1 scope. Its **concept** — fail closed on a resource type that is neither allowlisted nor forbidden — is valuable, and is present in this repo as the `required` + `Unsupported` fail-closed behaviour in `check_invariants.py` rather than as a second scope checker with duplicated parsing logic. Recorded as a limitation rather than silently dropped. |
| `README.md` (infra) | Not copied. Every sentence describes MAIA's wave structure, cost position and rollback, and would be false in this repository. Replaced by this document plus `COMPLETION-MATRIX.md`. |
| `parameters/v1-*.bicepparam`, `params/v1.dev.bicepparam` | Not copied. Same shape as the main parameter files with MAIA-specific names; two copies of a parameter contract is one too many. |
| `parameters/v6-*.bicepparam` | Not copied. Point at `main.v6-target.bicep`, which is not copied. |
| Hard-coded tenant IDs | Not copied. Every id in Helpdesk's parameter files is the zero GUID `00000000-0000-0000-0000-000000000000`, which fails an ARM lookup loudly at what-if. `validate.sh` step 6 asserts this and fails on any other tenant-shaped or principal-shaped value. |
| `containerImage` values | Not copied. The source image reference `ghcr.io/imtarget05/maia-maia-api:a82f24b2…` is a real, live artefact from another organisation's registry. Helpdesk's committed images sit in this repository's own namespace and `validate.sh` step 6 fails on any committed image that does not. |
| Historical evidence in `validate/known-weak/*` and `validate/negative-secret/*` | Not copied verbatim. The **events** are recorded — an injected `enablePurgeProtection: false` that a fully green suite missed, and a case-sensitive secret scanner blind to the repo's own `*_KEY` convention — because an evidence trail is what stops the same gap being reopened. The narration is Helpdesk's own. |

## New in Helpdesk, with no source counterpart

These modules do not exist in the source tree and were written for this stack:

| Module | Why it is needed here |
|---|---|
| `modules/postgres` | Durable helpdesk state: tickets, assets, incidents, audit events, approval requests, automation runs, SLA metadata. The source stack has no relational store — its state is in-process. |
| `modules/redis` | Session + SLA-dedup + job-dedup cache. Explicitly documented as having **no** embedding/vector role, because the source stack's most prominent dependency was exactly that. |
| `modules/storage` | Ticket attachments, CSV exports (`GET /api/assets/export.csv`, `GET /api/tickets/export.csv`), backup blobs written by `scripts/Backup-HelpdeskData.ps1`. |
| `modules/service-bus` | The automation pipeline as a queue with a first-class DLQ. The source stack has no messaging. The DLQ is a separate resource rather than a property because `automation/policy.py` marks `new_company_user`, `disable_company_user` and `restore_helpdesk_data` HIGH_RISK: a message that vanishes on its fifth failure is an unreviewed high-risk action. |
| `modules/networking` | VNet + three subnets + the Container Apps environment. The source stack has no networking module. |
| `modules/private-endpoints` | One module for all five data-tier endpoints, with the DNS zone group driven off the **same** `var endpoints` list as the endpoints themselves, so an endpoint cannot exist without its zone group. The source stack has no private endpoints at all. |
| `infra/scripts/check-independence.sh` | The enforcement mechanism for this document. Nothing in the source tree has an equivalent. |
| `infra/scripts/find_external_load_targets.py` | Extracted from the above because bash 3.2 (the `/bin/bash` on macOS) mis-parses a single-quoted argument nested inside `$( )`, killing the whole command substitution with a syntax error. Measured on this machine. |

## What was removed from the source's concepts

| Concept | Status in Helpdesk | Enforced by |
|---|---|---|
| Vector store / Qdrant / embeddings / RAG | **Absent.** The Helpdesk target has no retrieval component. | `check_invariants.py` step 7c asserts no `Microsoft.Search/`, `Microsoft.CognitiveServices/`, `Microsoft.DBforMongoDB/` or `Microsoft.DataFactory/` resource and no `qdrant` string anywhere in the compiled ARM JSON; `test_checker_traversal.py` cases H1–H3 prove each of those assertions bites. |
| MAIA env-var names (`QDRANT_*`, `CLOUDFLARE_*`, `EMBED_MODEL`, `VECTOR_STORE_BACKEND`, `AUTH_DB_URL`, `LLM_PROVIDER` as a MAIA-specific name) | **Absent.** `LLM_PROVIDER` exists in Helpdesk with the portal's own semantics, from `internal-portal/src/ai.js:115`. | `CONFIG-CONTRACT.md` is the authority; the parameter files transcribe it. |
| Entra app registration | **Absent.** Nothing in Helpdesk reads an Entra-issued token. The resulting gap is documented, not hidden. | `check_invariants.py` has no registration invariant because there is no registration to have one. |
| `main.v6-target.bicep` | **Absent.** | Not copied. |

## How to verify this document

```bash
./infra/validate.sh          # step 8 runs the independence proof
./infra/scripts/check-independence.sh   # just the independence proof
```

The independence check fails the run on: a symlink resolving outside the repo
root, a relative reference in `infra/` / `.github/` / `scripts/` that resolves
outside the repo root, a named reference to the source repository in those trees,
a git submodule, or a `load*Content()` whose target leaves the tree. It was
verified in both directions: it passes on the clean tree, and it was shown to fire
on an injected escaping symlink, an injected `module external '../ent-maia/...'` and
an injected `module external '../../../elsewhere/main.bicep'`. A check that has
never been shown to fail is an assumption, not a control.

## If you are about to deduplicate

Read the intent statement at the top of this document, then read
`infra/scripts/check-independence.sh`. Between them they are the recorded
decision, and the check that will fail your CI when you contradict it. If the two
stacks genuinely need the same behaviour, the correct move is a change to **both**
trees plus a test in each — not a shared module.