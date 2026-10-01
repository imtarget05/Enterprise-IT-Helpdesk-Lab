# Completion matrix — Helpdesk enterprise target

**This matrix is authoritative for this repository.**

Nothing in this repository has been deployed to Azure. Every row below is
therefore either `IMPLEMENTED_TESTED` (the artifact exists and a check in this
repository passes on it, run here) or `NOT_DEPLOYED` (the thing exists in source
but has never been exercised against a live service). **No row is
`VERIFIED_LIVE`, because no row has runtime evidence.**

Status vocabulary:

| Status | Meaning |
|---|---|
| `IMPLEMENTED_TESTED` | Implemented in this repository and a check in this repository passes. The check is named. |
| `NOT_DEPLOYED` | Implemented or specified, never exercised against a live service. |
| `NOT_STARTED` | Named in the target architecture, not written. |
| `DECISION_REQUIRED` | Cannot proceed until a human decides between named options. |

## Platform / infrastructure

| Component | Implementation | Tests | CI | Runtime evidence | Status | Limitations |
|---|---|---|---|---|---|---|
| Bicep toolchain | `infra/bicepconfig.json`, 17 `.bicep` files | `infra/validate.sh` step 1 compiles every file; warnings are a hard failure | `iac-validate.yml` → `Run IaC validation` | none | `IMPLEMENTED_TESTED` — 17/17 compile, 0 errors, 0 warnings, bicep 0.47.16 | Compiling proves shape, not deployability. No `what-if` has been run. |
| Entrypoint wiring | `infra/main.bicep` (subscription scope) | same as above | same | none | `IMPLEMENTED_TESTED` — 87 resources discovered in the compiled tree | Never deployed. `helpdeskDeployed` is emitted as literal `false` so a green run cannot be misread. |
| Parameter files | `infra/main.dev.bicepparam`, `main.prod.bicepparam` | `validate.sh` step 2 (`bicep build-params` resolves both) | same | none | `IMPLEMENTED_TESTED` | Every id is the zero GUID and every unique name is a placeholder. **Not deployable as committed** — by design. |
| Security invariants | `infra/scripts/check_invariants.py` — 6 property invariants on the compiled ARM JSON + 5 absence assertions | step 7 runs it against the real compiled template; `test_checker_traversal.py` (35 contracts) proves the checker actually traverses | same | none | `IMPLEMENTED_TESTED` — 6/6 invariants held across 87 resources; 35/35 traversal contracts | Covers only properties the module comments claim. PostgreSQL TLS is asserted by the platform, not by this checker — see the module comment. |
| Negative tests | `infra/validate/negative/*.bicepparam` (2) | step 3 — each MUST fail with a specific code (`BCP258`, `BCP033`) | same | none | `IMPLEMENTED_TESTED` | Two guards. The property invariants are the main defence. |
| Known-weak pins | `infra/validate/known-weak/*.bicepparam` (1) | step 4 — MUST still compile | same | none | `IMPLEMENTED_TESTED` | Key Vault name constraint is provider-enforced only. Promote to a negative test when it moves into a Bicep `assert`. |
| Secret scanning | `validate.sh` step 5 + step 5b negative control | step 5 must find nothing; 5b must find the fixture | same | none | `IMPLEMENTED_TESTED` | Regex-based, deliberately narrow. Not a replacement for a dedicated secret scanner over git history. |
| **Cross-repo independence** | `infra/scripts/check-independence.sh` — 5 checks: escaping symlinks, out-of-root relative references, sibling-repo names, git submodules, `load*Content()` targets | step 8; verified to fire on 3 injected violations (escaping symlink, `module '../ent-maia/…'`, `module '../../../elsewhere/…'`) | same | none | `IMPLEMENTED_TESTED` | Scope is `infra/`, `.github/`, `scripts/`. Application test fixtures are out of scope — their `../src/…` requires are demonstrably in-tree. |
| Resource groups | `infra/resourceGroups.bicep` — 2 RGs | compiles; ids emitted as outputs | same | none | `NOT_DEPLOYED` | Blast-radius argument is structural, not verified: no `az role assignment list` has been run. |
| Managed identities | `infra/modules/managed-identity/` — 2 UAMIs | compiles | same | none | `NOT_DEPLOYED` | Deliberately creates **no** Entra app registration — nothing reads one today. See CONFIG-CONTRACT gap 3. |
| Key Vault | `infra/modules/key-vault/` — RBAC only, purge protection on | invariants assert both properties on the compiled artifact | same | none | `IMPLEMENTED_TESTED` (properties) / `NOT_DEPLOYED` (resource) | Deps empty by design. `enablePrivateNetwork: false` in both parameter files. |
| PostgreSQL | `infra/modules/postgres/` | compiles; firewall-width check in step 7 | same | none | `NOT_DEPLOYED` | The portal still uses `DATA_DIR/db.json`. **Nothing is wired to this server.** The migration is not started. |
| Redis | `infra/modules/redis/` | invariants assert `enableNonSslPort: false` | same | none | `NOT_DEPLOYED` | No session cache integration exists in the portal yet. |
| Storage | `infra/modules/storage/` — 5 containers | invariants assert `allowBlobPublicAccess: false`, `supportsHttpsTrafficOnly: true` | same | none | `NOT_DEPLOYED` | The portal writes to the container filesystem, not to blob. Not integrated. |
| Service Bus | `infra/modules/service-bus/` — `helpdesk-automation-jobs` + `helpdesk-automation-dlq` + outcome topic | invariants assert `disableLocalAuth: true` | same | none | `NOT_DEPLOYED` | **The gateway has no Service Bus client.** `automation/gateway.py` proposes and `executor.py` executes in one process today. The queue is a target, not a wiring. |
| Monitoring | `infra/modules/monitoring/` — Log Analytics + App Insights | compiles | same | none | `NOT_DEPLOYED` | Diagnostic settings reference the workspace id but no resource exists. The gateway's `LLM_LOG_PATH` telemetry is not wired here. |
| Networking | `infra/modules/networking/` — VNet, `snet-apps` (delegated), `snet-private-endpoints`, `snet-data`, NSG | compiles | same | none | `NOT_DEPLOYED` | `10.20.0.0/16` is a guess. It must not overlap any network the subscription peers with. |
| Private endpoints | `infra/modules/private-endpoints/` — 5 endpoints + DNS zone groups, one shared `var endpoints` | compiles; independence check asserts all `load*Content()` resolve in-tree | same | none | `NOT_DEPLOYED` | Gated on `deployPrivateEndpoints = false` in both parameter files. Requires operator-supplied private DNS zone **ids** (the module deliberately does not create zones — a duplicate zone splits resolution). |
| Container Apps | `infra/modules/container-app/` — `ca-helpdesk-portal`, `ca-helpdesk-automation` | compiles | same | none | `NOT_DEPLOYED` | Committed images are `example-org/…:dev-placeholder` / `:prod-placeholder` — **not built, not pushable.** No ACA environment exists. |
| APIM | `infra/modules/apim/` — service, api-surface, per-operation policy | compiles; 3 `load*Content()` targets resolve in-tree | same | none | `NOT_DEPLOYED` + **`DECISION_REQUIRED`** | `operation-protected.xml` validates a JWT the portal does not mint. See CONFIG-CONTRACT gap 3. Also: Consumption SKU cannot be privatised; Front Door therefore fronts an internet-facing gateway. |
| Front Door + WAF | `infra/modules/front-door/` | compiles | same | none | `NOT_DEPLOYED` | Premium SKU. **Real monthly cost, not approved by this tree.** WAF rule set is DRS 1.0; the upgrade to 2.1 is an open item. |
| RBAC | `infra/modules/rbac/` — 7 grants + deploy Contributor, 1 invocation per RG | compiles | same | none | `NOT_DEPLOYED` | Grant set is reasoned in comments; no `az role assignment list` has confirmed it. |
| Deployment runbook | — | — | — | — | `NOT_STARTED` | No what-if, no deployment, no verification checklist executed. This is the next wave and it needs its own evidence. |

## Application (pre-existing, unchanged by this work)

| Component | Implementation | Tests | CI | Runtime evidence | Status | Limitations |
|---|---|---|---|---|---|---|
| Portal REST API | `internal-portal/` (Express, JSON-file persistence) | `cd internal-portal && npm test` — **336 pass, 1 skip, 0 fail** | `ci.yml` job `portal-tests` | none | `IMPLEMENTED_TESTED` | Persists to `DATA_DIR/db.json`: single-writer, lost on restart. The PostgreSQL migration is not started. |
| Portal tests | 36 files under `internal-portal/test/` | 337 tests collected, 336 pass, 1 skip (the live-endpoint guard, which skips itself by design) | same | none | `IMPLEMENTED_TESTED` | One test is timing-sensitive and flaked once under full-suite load (`notifier-ordering.test.js:243`, asserts `elapsedMs < 1500`, measured 1719 ms). It passed on re-run and in 3 isolated runs. Not weakened. |
| PowerShell scripts | `scripts/*.ps1` (8 files) | `bash scripts/verify-ps1-syntax.sh` — 8/8 parse clean via the real `pwsh` AST parser | `ci.yml` job `ps1-syntax` | none | `IMPLEMENTED_TESTED` | Parse-verified only. The automation worker has never executed one against a live AD. |
| LLM gateway + automation policy | `llm-gateway/` (FastAPI), `llm-gateway/automation/` | Python suite exists under `llm-gateway/tests/` — **not run in this task** (see below) | `ci.yml` job `python-portal-tests` targets the Flask alternate, `llm-gateway.yml` targets the gateway | none | `IMPLEMENTED_TESTED` (per its own CI) / not re-measured here | Not touched, not re-measured, and out of scope for this infrastructure task. |
| Observability config | `observability/` (Prometheus, Grafana, Alertmanager, `slo.yaml`) | not re-run here | `ci.yml` | none | not measured | The Azure Log Analytics workspace is the target; the Compose stack is the current lab form. |

## Not started

| Component | Why it is listed |
|---|---|
| Entra ID app registration for the portal | Needed before APIM's `validate-jwt` can validate anything. Deliberately absent from `modules/managed-identity` because nothing reads a token today. Decision, not code. |
| PostgreSQL schema + migration | 87 resources exist in the template tree; zero of them are connected to the running portal. |
| Service Bus client in the gateway | `automation/gateway.py` and `executor.py` run in one process. Splitting them is what makes the identity split meaningful. |
| Private-path deployment wave | Everything is written and gated on one flag. Needs operator-supplied DNS zone ids. |
| Cost-approved deployment of APIM + Front Door | Both carry real cost. |

## Honest summary

- **17 Bicep files compile clean** (0 errors, 0 warnings) on bicep 0.47.16.
- **6 security invariants hold** across the 87 resources in the compiled template.
- **35 checker traversal contracts hold.**
- **2 negative tests fail as required**, with the expected error codes.
- **1 known-weak pin still compiles**, as required.
- **5 independence checks pass**, and the same script was shown to fail on 3 injected cross-repo violations.
- **0 Azure resources exist.** Not one.
- **Portal tests: 336 pass, 1 skip, 0 fail.** One timing-sensitive test flaked once under full-suite load and passed on re-run; it was not weakened.

The gap between "the templates are correct" and "the platform works" is exactly the deployment wave, and it has not happened.
