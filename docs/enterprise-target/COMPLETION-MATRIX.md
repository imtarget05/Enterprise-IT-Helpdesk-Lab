# COMPLETION MATRIX — Enterprise-IT-Helpdesk-Lab

```text
derived_from : docs/enterprise-target/CURRENT-STATE.md
measured_at  : 2026-10-01
blocker      : branch DIVERGENT from origin/main (+2 / -1) — reconcile before Phase 1
```

## Status vocabulary

```text
VERIFIED_LIVE       measured on a live Azure runtime; evidence retained
VERIFIED_TRANSIENT  measured in a transient env that was then destroyed; evidence retained
IMPLEMENTED_TESTED  code + tests exist AND a green suite was observed at a frozen SHA
N/A_WITH_EVIDENCE   outside required scope, with a written reason

INTERIM (must be resolved before Phase 12 freeze — never a terminal state):

IMPLEMENTED_UNVERIFIED  source + tests exist; suite NOT re-run this pass; runtime not verified
UNMEASURED              required; not yet measured in this program
NOT_PASSING             a measured control currently fails
NOT_PRESENT             required; does not exist yet
```

No required row may be closed with `PARTIAL` / `PLANNED_ONLY` / `NOT_VERIFIED`.

## Matrix

| # | Required component | Status (now) | Evidence measured | Close in |
|---|---|---|---|---|
| 1 | Terraform as canonical IaC | **NOT_PRESENT** | 0 `*.tf`; Bicep only | Phase 1 |
| 2 | Remote state + GitHub OIDC | **NOT_PRESENT** | no secretless deploy path measured | Phase 2 |
| 3 | Import existing Azure resources (no recreate) | **UNMEASURED** | live inventory not probed | Phase 3 |
| 4 | VNet + Private Endpoints + Private DNS | **UNMEASURED** | `infra/modules/network` | Phase 4 |
| 5 | UAMI + Key Vault | **UNMEASURED** | `infra/modules/keyvault` (no `identity` module today) | Phase 4 |
| 6 | PostgreSQL durable approval store | **IMPLEMENTED_UNVERIFIED** | `internal-portal/src/postgres-adapter.js`; `internal-portal/test/postgres-adapter.test.js` | Phase 5 |
| 7 | Redis (rate limit / cache / idempotency TTL) | **UNMEASURED** | — | Phase 5 |
| 8 | Service Bus + Automation Worker + DLQ | **UNMEASURED** | `infra/modules/messaging` | Phase 5 |
| 9 | RBAC / role-based access on portal routes | **NOT_PRESENT** | documented capability gap | Phase 6 |
| 10 | Deterministic executor + post-condition verification | **UNMEASURED** | — | Phase 6 |
| 11 | Approval survives replica switch (A→B consistency) | **UNMEASURED** | — | Phase 6 |
| 12 | Audit trail | **UNMEASURED** | — | Phase 6 |
| 13 | OTel + App Insights + Log Analytics + Grafana + SLO | **UNMEASURED** | `infra/modules/observability` | Phase 7 |
| 14 | Front Door + WAF + APIM (edge) | **UNMEASURED** | no `edge`/`apim` module in Bicep today | Phase 8 |
| 15 | OCI build + SBOM + digest-pinned rollout | **UNMEASURED** | `build-container.yml` | Phase 9 |

> The live footprint is narrow (`authMode: "lab"`, mock webhook, no credential in probe). Any "live RBAC / durable approval" claim must restate that boundary. Carried figures (`137 passed`, restore-drill PASS on a `/tmp` fixture) are **CARRIED_FORWARD_NOT_REMEASURED**.

## AI Production Readiness (Phase 6A–6D)

> Mandatory gate between Phase 6 and Phase 7. Full spec: [`AI-PRODUCTION-GATE.md`](./AI-PRODUCTION-GATE.md).

| # | Required component | Status (now) | Evidence measured | Close in |
|---|---|---|---|---|
| 16 | 6A.1 Provider timeout / retry / fallback / circuit breaker | **UNMEASURED** | `llm-gateway` exists (CB/retry/PII per its README) — not verified end-to-end here | 6A |
| 17 | 6A.2 Side-effect idempotency (privileged action) | **UNMEASURED** | — | 6A |
| 18 | 6A.3 Structured proposal validation (schema + business + authz) | **UNMEASURED** | — | 6A |
| 19 | 6A.4 Direct prompt-injection controls | **UNMEASURED** | — | 6A |
| 20 | 6A.5 Retrieval / KB tenant isolation (if retrieval present) | **UNMEASURED** | — | 6A |
| 21 | 6A.6 No secrets in prompt / log / metric / trace | **UNMEASURED** | — | 6A |
| 22 | 6B.2 Durable HITL state (approval survives restart) | **UNMEASURED** | `postgres-adapter.js` is the durable seam — HITL persistence not verified | 6B |
| 23 | 6B.4 Least-privilege tools; no raw LLM execution authority | **UNMEASURED** | — | 6B |
| 24 | 6C.1 Bounded concurrency | **UNMEASURED** | — | 6C |
| 25 | 6C.5 AI cost metrics | **UNMEASURED** | — | 6C |
| 26 | 6D.1 Golden dataset | **UNMEASURED** | — | 6D |
| 27 | 6D.4 Slice-level regression gate | **UNMEASURED** | — | 6D |
| 28 | Phase 7 AI distributed tracing | **UNMEASURED** | `infra/modules/observability` | 7 |

## MCP + RAG + Agent (Phase 6E–6G)

> Full spec: [`MCP-RAG-AGENT.md`](./MCP-RAG-AGENT.md). Helpdesk identity: **Governed AI Agent + RAG + MCP Enterprise Automation**.

| # | Required component | Status (now) | Evidence measured | Close in |
|---|---|---|---|---|
| 29 | 6E KB retrieval hardening (ITIL / runbook) | **UNMEASURED** | — | 6E |
| 30 | 6F MCP platform (ticket / asset / knowledge / directory / automation) | **UNMEASURED** | — | 6F |
| 31 | 6F High-risk `automation.execute` behind HITL (never LLM-exposed) | **UNMEASURED** | — | 6F |
| 32 | 6G Agent + RAG + MCP end-to-end (ticket → HITL → executor → audit) | **UNMEASURED** | — | 6G |
